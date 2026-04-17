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
    } = data;

    // Validate and resolve image models
    const validatedModels = imageModelsInput.map((m) =>
      safeTextToImageModel(m)
    );
    const imageModels = resolveImageModels(
      validatedModels,
      imageModelLegacy ? safeTextToImageModel(imageModelLegacy) : undefined
    );
    const primaryImageModel = imageModels[0];

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

    return Promise.all(
      analysisModels.map(async (modelId) => {
        const sequence = await context.scopedDb.sequences.create({
          title: data.title || 'Untitled Sequence',
          script: data.script,
          styleId,
          aspectRatio,
          analysisModel:
            getAnalysisModelById(modelId)?.id || DEFAULT_ANALYSIS_MODEL,
          imageModel: primaryImageModel,
          videoModel,
          musicModel:
            musicModel && isValidAudioModel(musicModel)
              ? musicModel
              : DEFAULT_MUSIC_MODEL,
          autoGenerateMotion,
          autoGenerateMusic,
          suggestedTalentIds: suggestedTalentIds?.length
            ? suggestedTalentIds
            : undefined,
          suggestedLocationIds: suggestedLocationIds?.length
            ? suggestedLocationIds
            : undefined,
        });

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

    const sequence = await context.scopedDb.sequences.update({
      id: sequenceId,
      aspectRatio: updateData.aspectRatio ?? DEFAULT_ASPECT_RATIO,
      ...updateData,
      status: needsRegeneration ? 'processing' : undefined,
    });

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

    if (data.prompt || data.tags) {
      await context.scopedDb.sequences.updateMusicPrompt(
        sequence.id,
        data.prompt ?? sequence.musicPrompt ?? '',
        data.tags ?? sequence.musicTags ?? ''
      );
    }

    const allFrames = await context.scopedDb.frames.listBySequence(
      data.sequenceId
    );

    // For explicit calls with overrides, build input directly
    const effectivePrompt = data.prompt ?? sequence.musicPrompt;
    const effectiveTags = data.tags ?? sequence.musicTags;

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

    if (!effectivePrompt || !effectiveTags) {
      throw new Error('No music prompt or tags found');
    }

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
  .inputValidator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    const { sequence, user, teamId } = context;

    if (!sequence.musicUrl) {
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
      } satisfies MergeVideoWorkflowInput,
      { label: buildWorkflowLabel(sequence.id) }
    );

    return { success: true };
  });
