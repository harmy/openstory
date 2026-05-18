import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  isValidAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/lib/ai/models.config';
import { resolveImageModels } from '@/lib/ai/resolve-image-models';
import { requireTeamMemberAccess } from '@/lib/auth/action-utils';
import { estimateStoryboardCost } from '@/lib/billing/cost-estimation';
import { usdToMicros } from '@/lib/billing/money';
import { requireCredits } from '@/lib/billing/preflight';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import type { Frame } from '@/lib/db/schema';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import {
  createSequenceSchema,
  updateSequenceSchema,
} from '@/lib/schemas/sequence.schemas';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type {
  MergeVideoWorkflowInput,
  MusicSceneSummary,
  MusicWorkflowInput,
  StoryboardWorkflowInput,
} from '@/lib/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware, sequenceAccessMiddleware } from './middleware';
import { copySequenceElements } from '@/lib/sequence-elements/copy-sequence-elements';
import { promoteTempElements } from '@/lib/sequence-elements/promote-temp-elements';
import { bumpStylePopularity } from '@/lib/style/bump-style-popularity';

export const getSequencesFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequences.list();
  });

export const getSequenceFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    return context.sequence;
  });

/**
 * Create new sequence(s) with different analysis models.
 * Triggers storyboard generation workflow for each.
 */
export const createSequenceFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(createSequenceSchema))
  .handler(async ({ data, context }) => {
    const teamId = data.teamId || context.teamId;

    if (data.teamId && data.teamId !== context.teamId) {
      await requireTeamMemberAccess(context.user.id, data.teamId);
    }

    const {
      styleId,
      aspectRatio,
      analysisModels,
      imageModel: imageModelLegacy,
      imageModels: imageModelsInput,
      videoModel,
      autoGenerateMotion = false,
      autoGenerateMusic = true,
      musicModel,
      suggestedTalentIds,
      suggestedLocationIds,
      elementUploads,
      sourceSequenceId,
    } = data;

    // Verify source sequence access (scoped read returns null for other teams)
    if (sourceSequenceId) {
      const source = await context.scopedDb.sequences.getById(sourceSequenceId);
      if (!source) {
        throw new Error('Source sequence not found');
      }
    }

    // Validate and resolve image models
    const validatedModels = imageModelsInput.map((m) =>
      safeTextToImageModel(m)
    );
    const imageModels = resolveImageModels(
      validatedModels,
      imageModelLegacy ? safeTextToImageModel(imageModelLegacy) : undefined
    );
    const [primaryImageModel] = imageModels;
    if (!primaryImageModel) {
      throw new Error(
        'Expected resolveImageModels to return at least one model'
      );
    }

    if (!styleId || !aspectRatio) {
      throw new Error('Style ID and aspect ratio are required');
    }

    await requireCredits(
      context.scopedDb,
      estimateStoryboardCost({
        imageModel: primaryImageModel,
        imageModelCount: imageModels.length,
        aspectRatio,
        autoGenerateMotion,
        videoModel: safeImageToVideoModel(videoModel, DEFAULT_VIDEO_MODEL),
      }),
      {
        providers: ['fal', 'openrouter'],
        errorMessage: 'Insufficient credits to generate storyboard',
      }
    );

    const sequences = await Promise.all(
      analysisModels.map(async (modelId) => {
        // Only persist video/music model choices when the user actually opts
        // into auto-generation. Otherwise the sequence ends up with a "ghost"
        // model preference the user never picked, which surfaces stale values
        // in the header chip and batch footer. Tracked in #714.
        const persistedMusicModel =
          autoGenerateMusic && musicModel && isValidAudioModel(musicModel)
            ? musicModel
            : autoGenerateMusic
              ? DEFAULT_MUSIC_MODEL
              : undefined;

        const sequence = await context.scopedDb.sequences.create({
          title: data.title || 'Untitled Sequence',
          script: data.script,
          styleId,
          aspectRatio,
          analysisModel:
            getAnalysisModelById(modelId)?.id || DEFAULT_ANALYSIS_MODEL,
          imageModel: primaryImageModel,
          videoModel: autoGenerateMotion ? videoModel : undefined,
          musicModel: persistedMusicModel,
          autoGenerateMotion,
          autoGenerateMusic,
          suggestedTalentIds: suggestedTalentIds?.length
            ? suggestedTalentIds
            : undefined,
          suggestedLocationIds: suggestedLocationIds?.length
            ? suggestedLocationIds
            : undefined,
        });

        // Promote any draft element uploads to this new sequence (temp → final
        // path + insert rows + trigger vision). Runs before workflow trigger
        // so analyze-script-workflow can wait for vision to complete.
        if (elementUploads && elementUploads.length > 0) {
          await promoteTempElements({
            scopedDb: context.scopedDb,
            teamId,
            userId: context.user.id,
            sequenceId: sequence.id,
            uploads: elementUploads,
          });
        }

        // Carry forward elements from the source sequence when regenerating.
        // The script detail tab always creates a new sequence on Generate, so
        // without this the user's uploaded references (logos, products) would
        // silently disappear from the new run.
        if (sourceSequenceId) {
          await copySequenceElements({
            scopedDb: context.scopedDb,
            teamId,
            userId: context.user.id,
            sourceSequenceId,
            targetSequenceId: sequence.id,
          });
        }

        const workflowInput: StoryboardWorkflowInput = {
          userId: context.user.id,
          teamId,
          sequenceId: sequence.id,
          imageModels,
          options: {
            framesPerScene: 3,
            generateThumbnails: true,
            generateDescriptions: true,
            aiProvider: 'openrouter',
            regenerateAll: true,
          },
          autoGenerateMotion,
          autoGenerateMusic,
          musicModel:
            musicModel && isValidAudioModel(musicModel)
              ? musicModel
              : undefined,
          suggestedTalentIds,
          suggestedLocationIds,
        };

        await triggerWorkflow('/storyboard', workflowInput, {
          deduplicationId: `storyboard-${sequence.id}-${Date.now()}`,
          label: buildWorkflowLabel(sequence.id),
        });

        return sequence;
      })
    );

    // One click = one popularity bump + one analytics event, regardless of how
    // many analysis models the user picked. Fire-and-forget — never block.
    bumpStylePopularity({
      scopedDb: context.scopedDb,
      styleId,
      sequenceIds: sequences.map((s) => s.id),
      teamId,
      userId: context.user.id,
    });

    return sequences;
  });

/**
 * Update a sequence.
 * Triggers storyboard regeneration if script/style/aspectRatio/model changes.
 */
export const updateSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(updateSequenceSchema.extend({ sequenceId: ulidSchema }))
  )
  .handler(async ({ data, context }) => {
    const { sequenceId, ...updateData } = data;

    const needsRegeneration =
      updateData.script !== undefined ||
      updateData.styleId !== undefined ||
      updateData.aspectRatio !== undefined ||
      updateData.analysisModel !== undefined;

    const previousStyleId = context.sequence.styleId;

    const sequence = await context.scopedDb.sequences.update({
      id: sequenceId,
      aspectRatio: updateData.aspectRatio ?? DEFAULT_ASPECT_RATIO,
      ...updateData,
      status: needsRegeneration ? 'processing' : undefined,
    });

    // sequences.styleId is `.notNull() + onDelete: 'set null'` — TS types it as
    // non-null but the runtime value can be null after the parent style is
    // deleted. Keep the runtime guard despite what the type says.
    if (
      updateData.styleId !== undefined &&
      updateData.styleId !== previousStyleId &&
      sequence.styleId
    ) {
      bumpStylePopularity({
        scopedDb: context.scopedDb,
        styleId: sequence.styleId,
        sequenceIds: [sequence.id],
        teamId: context.teamId,
        userId: context.user.id,
      });
    }

    if (needsRegeneration) {
      await requireCredits(
        context.scopedDb,
        estimateStoryboardCost({
          imageModel: safeTextToImageModel(
            sequence.imageModel,
            DEFAULT_IMAGE_MODEL
          ),
          aspectRatio: sequence.aspectRatio,
          videoModel: safeImageToVideoModel(
            sequence.videoModel,
            DEFAULT_VIDEO_MODEL
          ),
        }),
        {
          providers: ['fal', 'openrouter'],
          errorMessage: 'Insufficient credits to regenerate storyboard',
        }
      );

      await triggerWorkflow(
        '/storyboard',
        {
          userId: context.user.id,
          teamId: context.teamId,
          sequenceId,
          options: {
            framesPerScene: 3,
            generateThumbnails: true,
            generateDescriptions: true,
            aiProvider: 'openrouter',
            regenerateAll: true,
          },
          autoGenerateMotion: sequence.autoGenerateMotion,
          autoGenerateMusic: sequence.autoGenerateMusic,
        } satisfies StoryboardWorkflowInput,
        { label: buildWorkflowLabel(sequence.id) }
      );
    }

    return sequence;
  });

// ============================================================================
// Retry Failed Storyboard
// ============================================================================

const retryStoryboardInputSchema = z.object({
  sequenceId: ulidSchema,
});

/**
 * Retry a failed storyboard workflow.
 * Re-triggers the full analyze-script pipeline for the sequence.
 */
export const retryStoryboardFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(retryStoryboardInputSchema))
  .handler(async ({ context }) => {
    const { sequence, user, teamId } = context;

    if (sequence.status !== 'failed') {
      throw new Error('Only failed sequences can be retried');
    }

    await requireCredits(
      context.scopedDb,
      estimateStoryboardCost({
        imageModel: safeTextToImageModel(
          sequence.imageModel,
          DEFAULT_IMAGE_MODEL
        ),
        aspectRatio: sequence.aspectRatio,
        videoModel: safeImageToVideoModel(
          sequence.videoModel,
          DEFAULT_VIDEO_MODEL
        ),
      }),
      {
        providers: ['fal', 'openrouter'],
        errorMessage: 'Insufficient credits to retry storyboard',
      }
    );

    // Reset status to processing before triggering
    await context.scopedDb.sequence(sequence.id).updateStatus('processing');

    const workflowInput: StoryboardWorkflowInput = {
      userId: user.id,
      teamId,
      sequenceId: sequence.id,
      options: {
        framesPerScene: 3,
        generateThumbnails: true,
        generateDescriptions: true,
        aiProvider: 'openrouter',
        regenerateAll: true,
      },
      autoGenerateMotion: sequence.autoGenerateMotion,
      autoGenerateMusic: sequence.autoGenerateMusic,
    };

    // No deduplication ID — explicit user retry should always run
    await triggerWorkflow('/storyboard', workflowInput, {
      label: buildWorkflowLabel(sequence.id),
    });

    return { success: true };
  });

/** Archive a sequence (hides from list, lets in-flight workflows finish) */
export const archiveSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    await context.scopedDb
      .sequence(context.sequence.id)
      .updateStatus('archived');
    return { success: true };
  });

/** Build compact scene summaries from frames for music prompt generation */
export function buildSceneSummaries(frames: Frame[]): MusicSceneSummary[] {
  return frames.map((frame) => {
    const md = frame.metadata?.musicDesign;
    const prompts = frame.metadata?.prompts;
    const legacyMusic = frame.metadata?.audioDesign?.music;
    const meta = frame.metadata?.metadata;
    const durationSeconds = frame.durationMs
      ? frame.durationMs / 1000
      : (meta?.durationSeconds ?? 10);

    return {
      sceneId: frame.id,
      location: meta?.location || '',
      timeOfDay: meta?.timeOfDay || '',
      visualSummary: prompts?.visual?.components.sceneDescription || '',
      title: meta?.title || 'Untitled Scene',
      storyBeat: meta?.storyBeat || '',
      durationSeconds,
      musicStyle: md?.style || legacyMusic?.style || '',
      musicMood: md?.mood || legacyMusic?.mood || '',
      musicPresence: md?.presence || legacyMusic?.presence || 'none',
      atmosphere: prompts?.visual?.components.atmosphere,
    };
  });
}

/**
 * Trigger sequence-level music generation.
 * Uses pre-generated prompt/tags when available, otherwise builds from frame audio specs.
 */
export const generateMusicFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        prompt: z.string().optional(),
        tags: z.string().optional(),
        model: z.string().optional(),
        duration: z.number().min(1).max(600).optional(),
      })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequence, user } = context;

    const effectivePrompt = data.prompt ?? sequence.musicPrompt;
    const effectiveTags = data.tags ?? sequence.musicTags;

    if (!effectivePrompt) {
      throw new Error(
        'Music prompt has not been generated yet — generate the storyboard first before editing music inputs.'
      );
    }
    if (!effectiveTags) {
      throw new Error('Music tags are required.');
    }

    // Persist the user's intent before triggering the workflow. Both
    // `data.prompt` and `data.tags` are surfaced as a single user-edit
    // revision; the variants helper updates the cached columns on `sequences`
    // alongside the row insert so a tags-only edit isn't dropped.
    if (data.prompt !== undefined || data.tags !== undefined) {
      await context.scopedDb.sequenceMusicPromptVariants.write({
        sequenceId: sequence.id,
        prompt: effectivePrompt,
        tags: effectiveTags,
        source: 'user-edit',
        createdBy: user.id,
      });
    }

    const allFrames = await context.scopedDb.frames.listBySequence(
      data.sequenceId
    );

    const totalDuration = allFrames.reduce((sum, frame) => {
      const seconds = frame.durationMs
        ? frame.durationMs / 1000
        : (frame.metadata?.metadata?.durationSeconds ?? 10);
      return sum + seconds;
    }, 0);

    const baseInput = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      duration: data.duration ?? (totalDuration || 30),
      model:
        data.model && isValidAudioModel(data.model) ? data.model : undefined,
    };

    const musicInput: MusicWorkflowInput = {
      ...baseInput,
      prompt: effectivePrompt,
      tags: effectiveTags,
    };

    await context.scopedDb.sequence(sequence.id).updateMusicFields({
      musicStatus: 'generating',
      musicError: null,
    });

    await triggerWorkflow('/music', musicInput, {
      label: buildWorkflowLabel(sequence.id),
    });

    return { success: true };
  });

/**
 * Re-merge all frame videos, then auto-chain to audio mux.
 * The merge-video workflow triggers merge-audio-video when music is ready.
 */
export const mergeVideoAndMusicFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        /** When `false`, restitch frame videos without muxing the generated
         *  music track. Default `true` preserves the legacy behavior. */
        includeMusic: z.boolean().optional(),
      })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequence, user, teamId } = context;
    const includeMusic = data.includeMusic !== false;

    if (includeMusic && !sequence.musicUrl) {
      throw new Error('Music must be generated before merging');
    }

    const frames = await context.scopedDb.frames.listBySequence(sequence.id);

    if (frames.length === 0) {
      throw new Error('No frames found in sequence');
    }

    const incompleteCount = frames.filter(
      (f) => f.videoStatus !== 'completed' || !f.videoUrl
    ).length;

    if (incompleteCount > 0) {
      throw new Error(
        `${incompleteCount} frame(s) do not have completed videos`
      );
    }

    await requireCredits(context.scopedDb, usdToMicros(0.01), {
      errorMessage: 'Insufficient credits for video merge',
    });

    await context.scopedDb.sequence(sequence.id).updateMergedVideoFields({
      mergedVideoStatus: 'merging',
      mergedVideoError: null,
    });

    const videoUrls = frames
      .sort((a, b) => a.orderIndex - b.orderIndex)
      .map((f) => f.videoUrl)
      .filter((url): url is string => Boolean(url));

    await triggerWorkflow(
      '/merge-video',
      {
        userId: user.id,
        teamId,
        sequenceId: sequence.id,
        videoUrls,
        skipAudioMux: !includeMusic,
      } satisfies MergeVideoWorkflowInput,
      { label: buildWorkflowLabel(sequence.id) }
    );

    return { success: true };
  });
