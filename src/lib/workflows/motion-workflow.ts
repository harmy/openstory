/**
 * Cloudflare Workflows port of `generateMotionWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/motion-workflow.ts`) step
 * for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run` and `step.sleep` instead of
 *     `context.sleep`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`.
 *   - Throws `NonRetryableError` from `cloudflare:workflows` in place of
 *     `WorkflowNonRetryableError` from `@upstash/workflow`. */

import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import { computeMotionPromptInputHash } from '@/lib/ai/input-hash';
import { DEFAULT_VIDEO_MODEL, IMAGE_TO_VIDEO_MODELS } from '@/lib/ai/models';
import { loadNarrowFramePromptContext } from '@/lib/ai/prompt-context';
import { microsToUsd, type Microdollars } from '@/lib/billing/money';
import type { ScopedDb } from '@/lib/db/scoped';
import { ensureImageUnderLimit } from '@/lib/image/image-compress';
import {
  calculateMotionMetadata,
  pollMotionJob,
  submitMotionJob,
} from '@/lib/motion/motion-generation';
import { uploadVideoToStorage } from '@/lib/motion/video-storage';
import { endSpanSuccess, startGenAISpan } from '@/lib/observability/tracer';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type { MotionWorkflowInput } from '@/lib/workflow/types';
import { shouldRecordUserEdit } from '@/lib/workflows/user-edit-predicate';
import { NonRetryableError } from 'cloudflare:workflows';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'motion']);

/** Each batch polls in a tight loop for ~30s, then checkpoints for durability */
const POLL_BATCH_DURATION_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
/** 30 batches × 30s = 15 minutes total timeout */
const MAX_BATCHES = 30;
/** Kling rejects start frame images over 10MB — use 9.5MB safety margin */
const KLING_MAX_IMAGE_BYTES = 9.5 * 1024 * 1024;

type MotionWorkflowResult = {
  videoUrl: string;
  duration: number;
};

function recordMotionObservation(params: {
  model: string;
  prompt: string;
  imageUrl: string;
  videoUrl: string;
  cost: Microdollars;
  videoDuration: number;
  generationTimeMs: number;
}) {
  const span = startGenAISpan('fal-motion', {
    model: params.model,
    provider: 'fal',
    operation: 'generate_content',
    input: { prompt: params.prompt, imageUrl: params.imageUrl },
    metadata: {
      videoDuration: params.videoDuration,
      generationTimeMs: params.generationTimeMs,
    },
  });
  span.setAttribute('gen_ai.usage.cost', microsToUsd(params.cost));
  endSpanSuccess(span, { videoUrl: params.videoUrl });
}

export class MotionWorkflow extends OpenStoryWorkflowEntrypoint<MotionWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MotionWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<MotionWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;
    const model = input.model || DEFAULT_VIDEO_MODEL;

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    if (!input.imageUrl?.trim()) {
      throw new WorkflowValidationError(
        'Thumbnail Path is required for motion generation'
      );
    }

    // Step 0: Get cost and check if team has enough credits
    const { cost, duration } = await step.do('check-credits', async () => {
      const { cost, duration } = calculateMotionMetadata({
        imageUrl: input.imageUrl,
        prompt: input.prompt,
        model,
        duration: input.duration,
        fps: input.fps,
        motionBucket: input.motionBucket,
        aspectRatio: input.aspectRatio,
        generateAudio: input.generateAudio,
      });

      const falKeyInfo = await scopedDb.apiKeys.resolveKey('fal');
      const usedOwnKey = falKeyInfo.source === 'team';
      if (cost > 0 && !usedOwnKey) {
        const canAfford = await scopedDb.billing.hasEnoughCredits(cost);
        if (!canAfford) {
          logger.warn(
            `[MotionWorkflow:cf] Insufficient credits for team ${input.teamId} (cost: $${microsToUsd(cost).toFixed(4)}), skipping deduction`
          );
          throw new NonRetryableError(
            `Insufficient credits for motion generation`
          );
        }
      }
      return { cost, duration };
    });

    // Step 1: Set status to generating and store model being used
    const { frameDeleted } = await step.do(
      'set-generating-status',
      async () => {
        if (!input.frameId) return { frameDeleted: false };

        const frame = await scopedDb.frames.update(
          input.frameId,
          {
            videoStatus: 'generating',
            videoWorkflowRunId: workflowRunId,
            motionModel: model,
          },
          { throwOnMissing: false }
        );

        if (!frame) {
          logger.info(
            `[MotionWorkflow:cf] Frame ${input.frameId} was deleted, skipping workflow`
          );
          return { frameDeleted: true };
        }

        if (
          shouldRecordUserEdit({
            userEditedPrompt: input.userEditedPrompt,
            prompt: input.prompt,
            currentPrompt: frame.motionPrompt,
          })
        ) {
          let userEditInputHash: string | null = null;
          let userEditAnalysisModel: string | null = null;
          try {
            if (frame.metadata && input.sequenceId) {
              const sequence = await scopedDb.sequences.getById(
                input.sequenceId
              );
              if (sequence) {
                const ctx = await loadNarrowFramePromptContext({
                  scopedDb,
                  sequence: {
                    id: sequence.id,
                    styleId: sequence.styleId,
                    aspectRatio: sequence.aspectRatio,
                    analysisModel: sequence.analysisModel,
                  },
                  scene: frame.metadata,
                });
                userEditInputHash = await computeMotionPromptInputHash(ctx);
                userEditAnalysisModel = ctx.analysisModel;
              }
            }
          } catch (err) {
            logger.warn(
              `[MotionWorkflow:cf] Could not compute upstream hash for user-edit on frame ${input.frameId}; recording with null hash`,
              {
                err,
              }
            );
          }

          await scopedDb.framePromptVariants.write({
            frameId: input.frameId,
            promptType: 'motion',
            text: input.prompt,
            source: 'user-edit',
            inputHash: userEditInputHash,
            analysisModel: userEditAnalysisModel,
            createdBy: input.userId,
          });
        }

        try {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.video:progress',
            { frameId: input.frameId, status: 'generating' }
          );
        } catch (emitError) {
          logger.error(
            `[MotionWorkflow:cf] Failed to emit generation.video:progress for frame ${input.frameId}:`,
            {
              err: emitError,
            }
          );
        }
        return { frameDeleted: false };
      }
    );

    if (frameDeleted) {
      return { videoUrl: '', duration: 0 };
    }

    // Step 2: Prepare start image — use Cloudflare Image Resizing if Kling model and image exceeds 10MB
    const startImageUrl = await step.do('prepare-start-image', async () => {
      const modelConfig = IMAGE_TO_VIDEO_MODELS[model];
      if (modelConfig.provider !== 'Kling') {
        return input.imageUrl;
      }

      const compressed = await ensureImageUnderLimit(
        input.imageUrl,
        KLING_MAX_IMAGE_BYTES
      );
      if (!compressed) {
        return input.imageUrl;
      }

      logger.info(
        `[MotionWorkflow:cf] Image ${(compressed.originalSizeBytes / 1024 / 1024).toFixed(1)}MB exceeds limit, using Cloudflare Image Resizing`
      );

      return compressed.url;
    });

    // Step 3a: Submit the motion generation job
    const job = await step.do('submit-motion', async () => {
      return await submitMotionJob({
        imageUrl: startImageUrl,
        prompt: input.prompt,
        model,
        duration: input.duration,
        fps: input.fps,
        motionBucket: input.motionBucket,
        aspectRatio: input.aspectRatio,
        generateAudio: input.generateAudio,
        scopedDb,
      }).catch((error) => {
        if (
          error instanceof Error &&
          'status' in error &&
          error.status === 422
        ) {
          throw new NonRetryableError(
            `Motion job submission rejected (422): ${extractFalErrorMessage(error)}`
          );
        }
        // If the error is not a 422, throw it. We'll retry
        throw error;
      });
    });

    // Step 3b: Batched polling — tight loop inside each step.do, checkpoint between batches
    let videoUrl = '';

    // Note how this works with workflow
    // The loop will run from 0 every time, but
    // the serialized result from step.do will be returned immediately from previous runs,
    //  so the loop will properly execute pollMotionJob a max of MAX_BATCHES times
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      if (batch > 0) {
        await step.sleep(`motion-batch-wait-${batch}`, 1);
      }

      const poll = await step.do(`motion-poll-batch-${batch}`, async () => {
        const deadline = Date.now() + POLL_BATCH_DURATION_MS;

        while (Date.now() < deadline) {
          const pollResult = await pollMotionJob(
            job.jobId,
            job.modelKey,
            scopedDb
          ).catch((error) => {
            if (
              error instanceof Error &&
              'status' in error &&
              error.status === 422
            ) {
              throw new NonRetryableError(
                `Motion job polling failed (422): ${extractFalErrorMessage(error)}`
              );
            }
            // If the error is not a 422, throw it. We'll retry
            throw error;
          });

          if (pollResult.progress !== undefined) {
            logger.info(
              `[MotionWorkflow:cf] Progress: ${pollResult.progress}%`
            );
          }

          if (pollResult.status === 'completed') {
            if (pollResult.url) {
              logger.info(`[MotionWorkflow:cf] Generation completed`);
              return pollResult;
            } else {
              throw new NonRetryableError(
                `Motion generation failed: ${pollResult.error || 'No URL returned'}`
              );
            }
          }
          if (pollResult.status === 'failed') {
            throw new NonRetryableError(
              `Motion generation failed: ${pollResult.error || 'Unknown error'}`
            );
          }

          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }

        return { status: 'pending' as const };
      });
      // Note poll is serialised by the workflow
      // this loop will run again, but always break as status will be completed
      if (poll.status === 'completed' && 'url' in poll && poll.url) {
        videoUrl = poll.url;
        break;
      }

      if (poll.status === 'failed') {
        throw new Error(
          ('error' in poll && poll.error) || 'Motion generation failed'
        );
      }
    }

    if (!videoUrl) {
      throw new Error('Motion generation timed out after 15 minutes');
    }

    await step.do('record-motion-observation', async () => {
      recordMotionObservation({
        model,
        prompt: input.prompt,
        imageUrl: input.imageUrl,
        videoUrl,
        cost: cost,
        videoDuration: duration,
        generationTimeMs: Date.now() - job.submittedAt,
      });
    });

    // Deduct credits (skip if team used own fal key)
    if (cost > 0 && input.teamId && !job.usedOwnKey) {
      await step.do('deduct-credits', async () => {
        await scopedDb.billing.deductCredits(cost, {
          description: `Motion generation (${model})`,
          metadata: {
            model,
            frameId: input.frameId,
            sequenceId: input.sequenceId,
            duration: duration,
          },
        });
      });
    }

    if (input.frameId) {
      const { frameId } = input;

      // Step 3: Fetch frame and sequence data for human-readable filename
      const frameData = await step.do('fetch-frame-data', async () => {
        const frame = await scopedDb.frames.getWithSequence(frameId);
        if (!frame) throw new Error('Frame not found');
        return {
          sequenceTitle: frame.sequence.title,
          sceneTitle: frame.metadata?.metadata?.title,
        };
      });

      // Step 4: Upload video to storage
      const storageResult = await step.do('upload-to-storage', async () => {
        if (!input.teamId || !input.sequenceId) {
          throw new Error('Missing teamId or sequenceId for storage upload');
        }

        const result = await uploadVideoToStorage({
          videoUrl,
          teamId: input.teamId,
          sequenceId: input.sequenceId,
          frameId,
          sequenceTitle: frameData.sequenceTitle,
          sceneTitle: frameData.sceneTitle,
        });

        if (!result.success) {
          throw new Error('Failed to upload video');
        }

        return { path: result.path, url: result.url };
      });

      videoUrl = storageResult.url;

      // Step 5: Update frame with video path, URL, and status
      await step.do('update-frame', async () => {
        const updatedFrame = await scopedDb.frames.update(
          frameId,
          {
            videoPath: storageResult.path,
            videoUrl: storageResult.url,
            durationMs: duration * 1000,
            videoStatus: 'completed',
            videoGeneratedAt: new Date(),
            videoError: null,
          },
          { throwOnMissing: false }
        );

        if (!updatedFrame) {
          logger.info(
            `[MotionWorkflow:cf] Frame ${frameId} was deleted, skipping final update`
          );
          return;
        }

        try {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.video:progress',
            { frameId, status: 'completed', videoUrl: storageResult.url }
          );
        } catch (emitError) {
          logger.error(
            `[MotionWorkflow:cf] Failed to emit generation.video:progress for frame ${frameId}:`,
            {
              err: emitError,
            }
          );
        }
      });
    }

    // Return the video URL and duration
    return { videoUrl, duration };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<MotionWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;

    if (input.frameId && input.teamId) {
      await scopedDb.frames.update(
        input.frameId,
        {
          videoStatus: 'failed',
          videoError: error,
        },
        { throwOnMissing: false }
      );
    }

    if (input.sequenceId && input.frameId) {
      try {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.video:progress',
          { frameId: input.frameId, status: 'failed' }
        );
      } catch (emitError) {
        logger.error(
          `[MotionWorkflow:cf] Failed to emit generation.video:progress for frame ${input.frameId}:`,
          {
            err: emitError,
          }
        );
      }
    }

    logger.error(
      `[MotionWorkflow:cf] Motion generation failed for frame ${input.frameId}: ${error}`
    );
  }
}
