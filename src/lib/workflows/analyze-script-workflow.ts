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
import { getFalFlowControl, getLLMFlowControl } from './constants';
import { frameImagesWorkflow } from './frame-images-workflow';
import { locationBibleWorkflow } from './location-bible-workflow';
import { motionMusicPromptsWorkflow } from './motion-music-prompts-workflow';

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

    // Load sequence elements, polling briefly for vision descriptions to finish.
    //
    // Why this exists: reference elements (logos, product shots, etc.) are uploaded
    // via `finalizeElementUploadFn`, which fires `elementVisionWorkflow` async so
    // the upload response isn't blocked. That vision workflow generates the
    // `description` + `consistencyTag` used below in `elementsMinimal`, which is
    // passed to `sceneSplitWorkflow` so the LLM knows what each token (e.g. LOGO,
    // BOTTLE) depicts and can weave them into scene prompts correctly.
    //
    // If the user hits "Analyze" immediately after uploading, vision analysis may
    // still be pending/analyzing. Proceeding right away would hand the LLM bare
    // tokens with no visual context, producing weaker scene prompts and missing
    // reference-image matches downstream.
    //
    // The wait is bounded (30s) because vision calls hit external providers (Fal/
    // OpenRouter) and can stall — we'd rather degrade gracefully than block the
    // whole generation pipeline. Elements without a description still appear in
    // the prompt as known tokens; they're just excluded from reference-image lists.
    const elements = await context.run(
      'load-and-wait-for-elements',
      async () => {
        if (!sequenceId) return [];

        const MAX_WAIT_MS = 30_000;
        const POLL_INTERVAL_MS = 1500;
        const startedAt = Date.now();

        // oxlint-disable-next-line no-unnecessary-condition -- loop has a break condition
        while (true) {
          const list = await scopedDb.sequenceElements.list(sequenceId);
          const stillAnalyzing = list.filter(
            (el) =>
              el.visionStatus === 'pending' || el.visionStatus === 'analyzing'
          );
          if (stillAnalyzing.length === 0) return list;
          if (Date.now() - startedAt > MAX_WAIT_MS) {
            console.warn(
              `[AnalyzeScriptWorkflow] Proceeding with ${stillAnalyzing.length} elements still analyzing`
            );
            return list;
          }
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
      }
    );

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
        flowControl: getFalFlowControl(),
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
        flowControl: getFalFlowControl(),
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
        flowControl: getLLMFlowControl(),
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

    // Phase 4: Frame images + variants AND motion + music prompts in parallel
    const [frameImagesResult, motionMusicResult] = await Promise.all([
      context.invoke('frame-images', {
        workflow: frameImagesWorkflow,
        label,
        body: {
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
        } satisfies FrameImagesWorkflowInput,
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

        const matchedFrame = frameMapping.find(
          (f) => f.sceneId === scene.sceneId
        );

        return {
          frameId: matchedFrame?.frameId ?? '',
          imageUrl: imageUrls[index],
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
      await context.invoke('motion-batch', {
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
