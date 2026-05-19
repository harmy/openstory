/**
 * Frame generation workflow
 * Orchestrates script analysis, frame creation, and thumbnail generation
 */

import { sanitizeScriptContent } from '@/lib/ai/prompt-validation';
import { resolveImageModels } from '@/lib/ai/resolve-image-models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { recordWorkflowTrace } from '@/lib/observability/langfuse';
import { getGenerationChannel } from '@/lib/realtime';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import {
  isOpenRouterAuthError,
  sanitizeFailResponse,
} from '@/lib/workflow/sanitize-fail-response';
import type {
  AnalyzeScriptWorkflowInput,
  BatchMotionMusicWorkflowInput,
  FrameImagesWorkflowInput,
  MotionMusicPromptsWorkflowInput,
} from '@/lib/workflow/types';

import { assembleMotionPrompt } from '@/lib/motion/assemble-motion-prompt';
import { motionBatchWorkflow } from '@/lib/workflows/motion-batch-workflow';
import { characterBibleWorkflow } from './character-bible-workflow';
import { frameImagesWorkflow } from './frame-images-workflow';
import { locationBibleWorkflow } from './location-bible-workflow';
import { motionMusicPromptsWorkflow } from './motion-music-prompts-workflow';
import {
  computeFrameImagesHashFromDto,
  type FrameImageSceneSnapshot,
} from './sheet-snapshots';
import {
  matchCharactersToScene,
  matchElementsToScene,
  matchLocationsToScene,
} from './scene-matching';

import { createScopedWorkflow } from '../workflow/scoped-workflow';
import { locationMatchingWorkflow } from './location-matching-workflow';
import { sceneSplitWorkflow } from './scene-split-workflow';
import { talentMatchingWorkflow } from './talent-matching-workflow';
import { visualPromptWorkflow } from './visual-prompt-workflow';

export const analyzeScriptWorkflow = createScopedWorkflow<
  AnalyzeScriptWorkflowInput,
  Scene[]
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const {
      sequenceId,
      script,
      aspectRatio,
      styleConfig,
      analysisModelId,
      imageModel,
      imageModels: imageModelsInput,
      videoModel,
      autoGenerateMotion = false,
      autoGenerateMusic = false,
      musicModel,
      suggestedTalentIds,
      suggestedLocationIds,
    } = input;

    const imageModels = resolveImageModels(imageModelsInput, imageModel);

    const label = buildWorkflowLabel(sequenceId);

    // Phase 1: Scene splitting
    if (!script) {
      throw new WorkflowValidationError('No script found');
    }
    // Record start time of analysis
    const startTime = await context.run('start-time', () => Date.now());

    // Phase 1 START
    await context.run('phase-1-start', async () => {
      await getGenerationChannel(sequenceId).emit('generation.phase:start', {
        phase: 1,
        phaseName: 'Analyzing script\u2026',
      });
    });

    // Load sequence elements. Element vision MUST be terminal (`completed` or
    // `failed`) before scene-split runs — otherwise the LLM would see a
    // placeholder description and the prompt-input hashes stamped on each frame
    // would diverge from the live hash once vision completes, surfacing as
    // false-positive "out of sync" indicators on every scene's Image/Motion tab.
    //
    // The UI gates Generate on `isBusy` (`element-selector.tsx`) which tracks
    // pending/analyzing vision status, so a draft upload with in-flight vision
    // can never reach here through the happy path. This check is defence in
    // depth — if a `pending` row does sneak in (e.g. a stale tab triggering
    // the mutation, or a developer wiring), we fail loudly rather than
    // degrading.
    const elements = await context.run('load-elements', async () => {
      if (!sequenceId) return [];
      const list = await scopedDb.sequenceElements.list(sequenceId);
      const stillRunning = list.filter(
        (el) => el.visionStatus === 'pending' || el.visionStatus === 'analyzing'
      );
      if (stillRunning.length > 0) {
        throw new WorkflowValidationError(
          `Element vision is still running for ${stillRunning.length} element(s). ` +
            `Wait for vision analysis to finish before regenerating.`
        );
      }
      return list;
    });

    const elementsMinimal = elements.map((el) => ({
      id: el.id,
      token: el.token,
      description: el.description,
      imageUrl: el.imageUrl,
      consistencyTag: el.consistencyTag,
    }));

    const sceneSplitResult = await context.invoke('scene-split', {
      workflow: sceneSplitWorkflow,
      label,
      body: {
        userId: input.userId,
        teamId: input.teamId,
        sequenceId,
        promptName: 'phase/scene-splitting-chat',
        aspectRatio,
        script: sanitizeScriptContent(script),
        styleConfig,
        modelId: analysisModelId,
        elements: elementsMinimal,
      },
    });

    if (sceneSplitResult.isFailed || sceneSplitResult.isCanceled) {
      throw new Error('Scene split workflow failed');
    }

    const {
      scenes,
      frameMapping,
      characterBible,
      locationBible,
      elementBible,
    } = sceneSplitResult.body;

    // Phase 2: Talent + location matching in parallel
    // Pass pre-extracted bibles to skip redundant extraction LLM calls
    // Phase 2 start event is emitted from scene-split-workflow when the
    // characterBible starts streaming. If bibles are empty (fallback path
    // or script has no characters), phase 3 start marks phase 2 complete
    // in the reducer — no separate emit needed.
    const [characterMatchingResult, locationMatchingResult] = await Promise.all(
      [
        context.invoke('talent-matching', {
          workflow: talentMatchingWorkflow,
          label,
          body: {
            sequenceId,
            userId: input.userId,
            teamId: input.teamId,
            analysisModelId,
            suggestedTalentIds,
            characterBible,
          },
        }),
        context.invoke('location-matching', {
          workflow: locationMatchingWorkflow,
          label,
          body: {
            sequenceId,
            userId: input.userId,
            teamId: input.teamId,
            analysisModelId,
            suggestedLocationIds,
            locationBible,
          },
        }),
      ]
    );
    if (characterMatchingResult.isFailed || characterMatchingResult.isCanceled)
      throw new Error('Character sheet generation failed');
    if (locationMatchingResult.isFailed || locationMatchingResult.isCanceled)
      throw new Error('Location sheet generation failed');

    const { matches: talentCharacterMatches } = characterMatchingResult.body;
    const { matches: libraryLocationMatches } = locationMatchingResult.body;

    // Phase 3 START
    await context.run('phase-3-start', async () => {
      await getGenerationChannel(sequenceId).emit('generation.phase:start', {
        phase: 3,
        phaseName: 'Generating references & prompts\u2026',
      });
    });

    // Phase 3: Character sheets, location sheets, and visual prompts in parallel
    const [charResult, locationResult, visualResult] = await Promise.all([
      context.invoke('character-sheet-from-bible', {
        workflow: characterBibleWorkflow,
        label,
        body: {
          sequenceId,
          userId: input.userId,
          teamId: input.teamId,
          characterBible,
          talentMatches: talentCharacterMatches,
          imageModel,
          styleConfig,
        },
      }),
      context.invoke('location-sheet-from-bible', {
        workflow: locationBibleWorkflow,
        label,
        body: {
          sequenceId,
          userId: input.userId,
          teamId: input.teamId,
          locationBible,
          libraryLocationMatches,
          styleConfig,
        },
      }),
      context.invoke('visual-prompts', {
        workflow: visualPromptWorkflow,
        label,
        body: {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          scenes,
          aspectRatio,
          characterBible,
          locationBible,
          elementBible,
          styleConfig,
          analysisModelId,
          frameMapping,
        },
      }),
    ]);

    if (charResult.isFailed || charResult.isCanceled)
      throw new Error('Character sheet generation failed');
    if (locationResult.isFailed || locationResult.isCanceled)
      throw new Error('Location sheet generation failed');
    if (visualResult.isFailed || visualResult.isCanceled)
      throw new Error('Visual prompt generation failed');

    const charactersWithSheets = charResult.body;
    const locationsWithSheets = locationResult.body;
    const scenesWithVisualPrompts = visualResult.body;

    // Phase 4 START
    await context.run('phase-4-start', async () => {
      await getGenerationChannel(sequenceId).emit('generation.phase:start', {
        phase: 4,
        phaseName: 'Generating images\u2026',
      });
    });

    // Build per-scene snapshots so frameImagesWorkflow's snapshot middleware
    // can validate the inlined sheet hashes haven't been swapped without a
    // matching snapshotInputHash.
    const sceneSnapshots: FrameImageSceneSnapshot[] =
      scenesWithVisualPrompts.map((scene) => {
        const characters = matchCharactersToScene(
          charactersWithSheets,
          scene.continuity?.characterTags ?? []
        );
        const locations = matchLocationsToScene(
          locationsWithSheets,
          scene.continuity?.environmentTag ?? '',
          scene.metadata?.location ?? ''
        );
        const elementsMatched = matchElementsToScene(
          elementsMinimal,
          scene.continuity?.elementTags ?? [],
          scene.originalScript.extract
        );
        return {
          sceneId: scene.sceneId,
          visualPrompt: scene.prompts?.visual?.fullPrompt ?? '',
          characterSheetHashes: characters
            .map((c) => c.sheetInputHash)
            .filter((h): h is string => typeof h === 'string')
            .sort(),
          locationSheetHashes: locations
            .map((l) => l.referenceInputHash)
            .filter((h): h is string => typeof h === 'string')
            .sort(),
          elementReferenceHashes: elementsMatched
            .map((e) => e.imageUrl)
            .filter((u) => u.length > 0)
            .sort(),
        };
      });

    const frameImagesPayload: FrameImagesWorkflowInput = {
      userId: input.userId,
      teamId: input.teamId,
      sequenceId,
      scenesWithVisualPrompts,
      charactersWithSheets,
      locationsWithSheets,
      elements: elementsMinimal,
      frameMapping,
      imageModel,
      imageModels,
      aspectRatio,
      sceneSnapshots,
    };
    frameImagesPayload.snapshotInputHash = await computeFrameImagesHashFromDto({
      ...frameImagesPayload,
      sceneSnapshots,
    });

    // Phase 4: Frame images + variants AND motion + music prompts in parallel
    const [frameImagesResult, motionMusicResult] = await Promise.all([
      context.invoke('frame-images', {
        workflow: frameImagesWorkflow,
        label,
        body: frameImagesPayload,
      }),
      context.invoke('motion-music-prompts', {
        workflow: motionMusicPromptsWorkflow,
        label,
        body: {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          scenesWithVisualPrompts,
          frameMapping,
          aspectRatio,
          characterBible,
          locationBible,
          elementBible,
          styleConfig,
          analysisModelId,
          videoModel,
        } satisfies MotionMusicPromptsWorkflowInput,
      }),
    ]);

    // Record analysis duration before generating motion
    await context.run('record-analysis-duration', async () => {
      if (sequenceId) {
        await scopedDb.sequences.updateAnalysisDurationMs(
          sequenceId,
          Date.now() - startTime
        );
      }
    });

    if (frameImagesResult.isFailed || frameImagesResult.isCanceled)
      throw new Error('Frame image generation failed');
    if (motionMusicResult.isFailed || motionMusicResult.isCanceled)
      throw new Error('Motion/music prompt generation failed');

    const imageUrls = frameImagesResult.body.imageUrls;
    const { completeScenes, musicPrompt, musicTags } = motionMusicResult.body;

    // Auto-generate motion + music if enabled
    const shouldGenerateMotion =
      autoGenerateMotion && videoModel && imageUrls.length > 0;
    const shouldGenerateMusic = Boolean(
      autoGenerateMusic &&
      sequenceId &&
      completeScenes.some(
        (s) => s.musicDesign?.presence && s.musicDesign.presence !== 'none'
      )
    );

    if (shouldGenerateMotion) {
      let totalDuration = 0;
      for (const scene of completeScenes) {
        totalDuration += scene.metadata?.durationSeconds || 5;
      }

      const batchFrames = completeScenes.map((scene, index) => {
        const motionPromptData = scene.prompts?.motion;
        if (!motionPromptData?.fullPrompt) {
          throw new WorkflowValidationError(
            `Scene ${scene.sceneId} has no motion prompt`
          );
        }

        const imageUrl = imageUrls[index];
        if (!imageUrl) {
          throw new WorkflowValidationError(
            `Scene ${scene.sceneId} has no generated image URL at index ${index}`
          );
        }

        const matchedFrame = frameMapping.find(
          (f) => f.sceneId === scene.sceneId
        );

        return {
          frameId: matchedFrame?.frameId ?? '',
          imageUrl,
          prompt: assembleMotionPrompt({
            motionPrompt: motionPromptData,
            model: videoModel,
          }),
          model: videoModel,
          duration: scene.metadata?.durationSeconds || 3,
          aspectRatio,
        };
      });

      // Phase 5 START
      await context.run('phase-5-start', async () => {
        await getGenerationChannel(sequenceId).emit('generation.phase:start', {
          phase: 5,
          phaseName: shouldGenerateMusic
            ? 'Generating motion & music\u2026'
            : 'Generating motion\u2026',
        });
      });

      // Phase 5: single orchestrator for motion + optional music + merge
      const motionBatchResult = await context.invoke('motion-batch', {
        workflow: motionBatchWorkflow,
        label,
        body: {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          includeMusic: shouldGenerateMusic,
          frames: batchFrames,
          music: shouldGenerateMusic
            ? {
                prompt: musicPrompt,
                tags: musicTags,
                duration: totalDuration,
                model: musicModel,
              }
            : undefined,
        } satisfies BatchMotionMusicWorkflowInput,
      });

      if (motionBatchResult.isFailed || motionBatchResult.isCanceled)
        throw new Error('Motion/music batch failed');
    }

    if (sequenceId) {
      await context.run('record-workflow-trace', async () => {
        await recordWorkflowTrace(
          'analyzeScriptWorkflow',
          { script, styleConfig, aspectRatio },
          completeScenes,
          sequenceId,
          input.userId,
          analysisModelId,
          new Date(startTime)
        );
      });
    }

    return completeScenes;
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const { sequenceId } = context.requestPayload;
      if (!sequenceId) return;

      const error = sanitizeFailResponse(failResponse);
      console.error('[AnalyzeScriptWorkflow] Failure:', error);

      let userMessage = error;
      if (
        isOpenRouterAuthError(error) &&
        (await scopedDb.apiKeys.hasKey('openrouter'))
      ) {
        await scopedDb.apiKeys.markKeyInvalid('openrouter', error);
        userMessage =
          'Your OpenRouter API key is invalid — update it in Settings.';
      }

      await scopedDb.sequence(sequenceId).updateStatus('failed', userMessage);
      await getGenerationChannel(sequenceId).emit('generation.failed', {
        message: userMessage,
      });

      return `Analysis workflow failed: ${error}`;
    },
  }
);
