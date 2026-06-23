/**
 * Motion Server Functions
 * Frame motion (image-to-video) generation operations.
 */

import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

import {
  AUDIO_MODELS,
  DEFAULT_VIDEO_MODEL,
  safeImageToVideoModel,
} from '@/lib/ai/models';
import { estimateVideoCost } from '@/lib/billing/cost-estimation';
import { multiplyMicros } from '@/lib/billing/money';
import { requireCredits } from '@/lib/billing/preflight';
import { resolveFrameDuration } from '@/lib/motion/resolve-frame-duration';
import { snapDuration } from '@/lib/motion/motion-generation';
import { generateMotionSchema } from '@/lib/schemas/frame.schemas';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { BatchMotionMusicWorkflowInput } from '@/lib/workflow/types';

import { resolveMotionPrompt } from '@/lib/motion/resolve-motion-prompt';
import { rescanContinuityFromPrompt } from '@/lib/scenes/rescan-continuity-from-prompt';

import { frameAccessMiddleware, sequenceAccessMiddleware } from './middleware';

// -- Generate Motion for Frame -------------------------------------------

const generateMotionInputSchema = generateMotionSchema.extend({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

export const generateShotMotionFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(generateMotionInputSchema))
  .handler(async ({ data, context }) => {
    const { shot: frame, sequence, teamId } = context;

    if (!frame.thumbnailUrl) {
      throw new Error('Frame has no thumbnail to generate motion from');
    }

    const model = safeImageToVideoModel(
      data.model || frame.motionModel || sequence.videoModel,
      DEFAULT_VIDEO_MODEL
    );

    const userEditedPrompt = Boolean(data.prompt);
    const prompt = data.prompt || resolveMotionPrompt(frame, model);

    // Auto-link any element/cast/location tags the user mentioned in their
    // edited motion prompt into frame.metadata.continuity, so downstream
    // consumers (next image regenerate, frame-image reference attachment)
    // see the new references. Motion itself uses image-to-video and doesn't
    // re-attach references here, but persisting keeps the data consistent.
    if (userEditedPrompt && frame.metadata?.continuity) {
      const rescan = await rescanContinuityFromPrompt({
        scopedDb: context.scopedDb,
        sequenceId: sequence.id,
        existing: frame.metadata.continuity,
        promptText: prompt,
      });
      if (rescan.changed) {
        await context.scopedDb.shots.update(frame.id, {
          metadata: { ...frame.metadata, continuity: rescan.continuity },
        });
      }
    }

    // Snap the resolved duration onto the selected model's valid set before
    // both the credit pre-flight and the workflow input — otherwise an
    // unsnapped value (e.g. legacy `durationMs` from a different model) gets
    // priced at the raw seconds while the workflow bills against the snapped
    // value, leaving the two paths inconsistent.
    const duration = resolveFrameDuration({
      explicit: data.duration,
      durationMs: frame.durationMs,
      metadataSeconds: frame.metadata?.metadata?.durationSeconds,
      model,
    });

    await requireCredits(context.scopedDb, estimateVideoCost(model, duration), {
      errorMessage: 'Insufficient credits for motion generation',
    });

    const workflowInput: BatchMotionMusicWorkflowInput = {
      userId: context.user.id,
      teamId,
      sequenceId: sequence.id,
      includeMusic: false,
      shots: [
        {
          shotId: frame.id,
          imageUrl: frame.thumbnailUrl,
          prompt,
          model,
          duration,
          fps: data.fps,
          motionBucket: data.motionBucket,
          aspectRatio: sequence.aspectRatio,
          generateAudio: data.generateAudio,
          userEditedPrompt,
        },
      ],
    };

    const workflowRunId = await triggerWorkflow(
      '/motion-batch',
      workflowInput,
      {
        deduplicationId: `motion-batch-${frame.id}-${Date.now()}`,
        label: buildWorkflowLabel(sequence.id),
      }
    );

    return { workflowRunId, shotId: frame.id };
  });

// -- Batch Generate Motion for Sequence ----------------------------------

const batchGenerateMotionInputSchema = z.object({
  sequenceId: ulidSchema,
  includeMusic: z.boolean().optional(),
  model: generateMotionSchema.shape.model,
  musicModel: z
    .enum(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Required for z.enum with dynamic keys
      Object.keys(AUDIO_MODELS) as [keyof typeof AUDIO_MODELS]
    )
    .optional(),
  duration: generateMotionSchema.shape.duration,
  fps: generateMotionSchema.shape.fps,
  motionBucket: generateMotionSchema.shape.motionBucket,
  generateAudio: generateMotionSchema.shape.generateAudio,
});

export const batchGenerateMotionFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(batchGenerateMotionInputSchema))
  .handler(async ({ data, context }) => {
    const { sequence, teamId, user } = context;

    const allFrames = await context.scopedDb.shots.listBySequence(sequence.id);
    // Server determines eligible frames: thumbnail done, video pending/failed
    const eligibleFrames = allFrames.filter(
      (f) =>
        f.thumbnailStatus === 'completed' &&
        f.thumbnailUrl &&
        (f.videoStatus === 'pending' || f.videoStatus === 'failed')
    );

    if (eligibleFrames.length === 0) {
      throw new Error('No eligible frames for motion generation');
    }

    const batchModel = data.model ?? DEFAULT_VIDEO_MODEL;
    const batchDuration = snapDuration(data.duration, batchModel);

    await requireCredits(
      context.scopedDb,
      multiplyMicros(
        estimateVideoCost(batchModel, batchDuration),
        eligibleFrames.length
      ),
      {
        errorMessage: `Insufficient credits for batch motion generation (${eligibleFrames.length} frames)`,
      }
    );

    const includeMusic =
      (data.includeMusic ?? false) && sequence.musicStatus !== 'generating';

    // Persist the batch model picks so the sequence header chip, future batch
    // sessions, and storyboard regen reflect what the user just chose.
    const videoModelChanged = data.model && data.model !== sequence.videoModel;
    const musicModelChanged =
      includeMusic &&
      data.musicModel &&
      data.musicModel !== sequence.musicModel;
    if (videoModelChanged || musicModelChanged) {
      await context.scopedDb.sequences.update({
        id: sequence.id,
        ...(videoModelChanged ? { videoModel: data.model } : {}),
        ...(musicModelChanged ? { musicModel: data.musicModel } : {}),
      });
    }

    // Build music config if requested
    let musicConfig: BatchMotionMusicWorkflowInput['music'];
    if (includeMusic) {
      if (!sequence.musicPrompt || !sequence.musicTags) {
        throw new Error('No music prompt or tags found');
      }

      const totalDuration = allFrames.reduce((sum, frame) => {
        const seconds = frame.durationMs
          ? frame.durationMs / 1000
          : (frame.metadata?.metadata?.durationSeconds ?? 10);
        return sum + seconds;
      }, 0);

      musicConfig = {
        prompt: sequence.musicPrompt,
        tags: sequence.musicTags,
        duration: totalDuration || 30,
        model: data.musicModel,
      };
    }

    const workflowInput: BatchMotionMusicWorkflowInput = {
      userId: user.id,
      teamId,
      sequenceId: sequence.id,
      includeMusic,
      shots: eligibleFrames.map((frame) => {
        const frameModel = safeImageToVideoModel(
          data.model || frame.motionModel || sequence.videoModel,
          DEFAULT_VIDEO_MODEL
        );
        return {
          shotId: frame.id,
          imageUrl: frame.thumbnailUrl ?? '',
          prompt: resolveMotionPrompt(frame, frameModel),
          model: frameModel,
          duration:
            data.duration ??
            (frame.durationMs
              ? frame.durationMs / 1000
              : frame.metadata?.metadata?.durationSeconds) ??
            3,
          fps: data.fps,
          motionBucket: data.motionBucket,
          aspectRatio: sequence.aspectRatio,
          generateAudio: data.generateAudio,
        };
      }),
      music: musicConfig,
    };

    const workflowRunId = await triggerWorkflow(
      '/motion-batch',
      workflowInput,
      {
        deduplicationId: `motion-batch-${sequence.id}-${Date.now()}`,
        label: buildWorkflowLabel(sequence.id),
      }
    );

    return {
      sequenceId: sequence.id,
      totalFrames: allFrames.length,
      eligibleFrames: eligibleFrames.length,
      workflowRunId,
      includeMusic,
    };
  });
