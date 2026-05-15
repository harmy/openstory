/**
 * Motion generation workflow
 * Generates video motion from static frame thumbnails (image-to-video)
 *
 * Uses batched polling: each context.run polls in a tight loop for ~30s,
 * then checkpoints via context.sleep between batches for durability.
 * This reduces QStash steps by ~10x vs one-step-per-poll.
 */

import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import { computeMotionPromptInputHash } from '@/lib/ai/input-hash';
import { DEFAULT_VIDEO_MODEL, IMAGE_TO_VIDEO_MODELS } from '@/lib/ai/models';
import { loadNarrowFramePromptContext } from '@/lib/ai/prompt-context';
import { microsToUsd, type Microdollars } from '@/lib/billing/money';
import { ensureImageUnderLimit } from '@/lib/image/image-compress';
import {
  calculateMotionMetadata,
  pollMotionJob,
  submitMotionJob,
} from '@/lib/motion/motion-generation';
import { uploadVideoToStorage } from '@/lib/motion/video-storage';
import { getGenerationChannel } from '@/lib/realtime';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  MergeVideoWorkflowInput,
  MotionWorkflowInput,
} from '@/lib/workflow/types';
import { endSpanSuccess, startGenAISpan } from '@/lib/observability/tracer';
import { WorkflowNonRetryableError } from '@upstash/workflow';
import {
  buildMergeVideoSourcesFromFrames,
  computeSequenceVideoHashFromDto,
} from './sequence-snapshots';
import { shouldRecordUserEdit } from './user-edit-predicate';

/** Each batch polls in a tight loop for ~30s, then checkpoints for durability */
const POLL_BATCH_DURATION_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
/** 30 batches × 30s = 15 minutes total timeout */
const MAX_BATCHES = 30;
/** Kling rejects start frame images over 10MB — use 9.5MB safety margin */
const KLING_MAX_IMAGE_BYTES = 9.5 * 1024 * 1024;

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

export const generateMotionWorkflow = createScopedWorkflow<MotionWorkflowInput>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const model = input.model || DEFAULT_VIDEO_MODEL;

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    if (!input.imageUrl?.trim()) {
      throw new WorkflowValidationError(
        'Thumbnail Path is required for motion generation'
      );
    }
    // Step 0: Get cost and check if team has enough credits
    // Calculate cost + metadata

    const { cost, duration } = await context.run('check-credits', async () => {
      const { cost, duration } = calculateMotionMetadata({
        imageUrl: input.imageUrl,
        prompt: input.prompt,
        model,
        duration: input.duration,
        fps: input.fps,
        motionBucket: input.motionBucket,
        aspectRatio: input.aspectRatio,
      });

      // Check if team has enough credits (resolve BYOK status before job submission)
      const falKeyInfo = await scopedDb.apiKeys.resolveKey('fal');
      const usedOwnKey = falKeyInfo.source === 'team';
      if (cost > 0 && !usedOwnKey) {
        const canAfford = await scopedDb.billing.hasEnoughCredits(cost);
        if (!canAfford) {
          console.warn(
            `[MotionWorkflow] Insufficient credits for team ${input.teamId} (cost: $${microsToUsd(cost).toFixed(4)}), skipping deduction`
          );

          // Throw an error so the workflow fails
          throw new WorkflowNonRetryableError(
            `Insufficient credits for motion generation`
          );
        }
      }
      return { cost, duration };
    });

    // Step 1: Set status to generating and store model being used
    const { frameDeleted } = await context.run(
      'set-generating-status',
      async () => {
        if (!input.frameId) return { frameDeleted: false };

        const frame = await scopedDb.frames.update(
          input.frameId,
          {
            videoStatus: 'generating',
            videoWorkflowRunId: context.workflowRunId,
            motionModel: model,
          },
          { throwOnMissing: false }
        );

        if (!frame) {
          console.log(
            `[MotionWorkflow] Frame ${input.frameId} was deleted, skipping workflow`
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
          // Stamp the user-edit with the upstream-context hash captured at
          // edit time so staleness detection survives a hand-typed prompt.
          // If anything blocks the compute, fall back to null.
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
            console.warn(
              `[MotionWorkflow] Could not compute upstream hash for user-edit on frame ${input.frameId}; recording with null hash`,
              err
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
          console.error(
            `[MotionWorkflow] Failed to emit generation.video:progress for frame ${input.frameId}:`,
            emitError
          );
        }
        return { frameDeleted: false };
      }
    );

    if (frameDeleted) {
      return { videoUrl: '', duration: 0 };
    }

    // Step 2: Prepare start image — use Cloudflare Image Resizing if Kling model and image exceeds 10MB
    const startImageUrl = await context.run('prepare-start-image', async () => {
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

      console.log(
        `[MotionWorkflow] Image ${(compressed.originalSizeBytes / 1024 / 1024).toFixed(1)}MB exceeds limit, using Cloudflare Image Resizing`
      );

      return compressed.url;
    });

    // Step 3a: Submit the motion generation job
    const job = await context.run('submit-motion', async () => {
      return await submitMotionJob({
        imageUrl: startImageUrl,
        prompt: input.prompt,
        model,
        duration: input.duration,
        fps: input.fps,
        motionBucket: input.motionBucket,
        aspectRatio: input.aspectRatio,
        scopedDb,
      }).catch((error) => {
        if (
          error instanceof Error &&
          'status' in error &&
          error.status === 422
        ) {
          throw new WorkflowNonRetryableError(
            `Motion job submission rejected (422): ${extractFalErrorMessage(error)}`
          );
        }
        // If the error is not a 422, throw it. We'll retry
        throw error;
      });
    });

    // Step 3b: Batched polling — tight loop inside each context.run, checkpoint between batches
    let videoUrl = '';

    // Note how this works with workflow
    // The loop will run from 0 every time, but
    // the serialized result from context.run will be returned immediately from previous runs,
    //  so the loop will properly execute pollMotionJob a max of MAX_BATCHES times
    for (let batch = 0; batch < MAX_BATCHES; batch++) {
      if (batch > 0) {
        await context.sleep(`motion-batch-wait-${batch}`, 1);
      }

      const poll = await context.run(`motion-poll-batch-${batch}`, async () => {
        const deadline = Date.now() + POLL_BATCH_DURATION_MS;

        while (Date.now() < deadline) {
          // Poll the job status
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
              throw new WorkflowNonRetryableError(
                `Motion job polling failed (422): ${extractFalErrorMessage(error)}`
              );
            }
            // If the error is not a 422, throw it. We'll retry
            throw error;
          });

          if (pollResult.progress !== undefined) {
            // Log the progress
            console.log(`[MotionWorkflow] Progress: ${pollResult.progress}%`);
          }

          // If the job is completed, check the video URL and return the result
          // If the video URL is not returned, throw an error and stop the workflow without retrying
          if (pollResult.status === 'completed') {
            if (pollResult.url) {
              console.log(`[MotionWorkflow] Generation completed`);
              return pollResult;
            } else {
              throw new WorkflowNonRetryableError(
                `Motion generation failed: ${pollResult.error || 'No URL returned'}`
              );
            }
          }
          // If the job is failed, throw an error and stop the workflow without retrying
          if (pollResult.status === 'failed') {
            throw new WorkflowNonRetryableError(
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

    await context.run('record-motion-observation', async () => {
      // Record Langfuse observation with cost and generation time
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
      await context.run('deduct-credits', async () => {
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
      const frameData = await context.run('fetch-frame-data', async () => {
        const frame = await scopedDb.frames.getWithSequence(frameId);
        if (!frame) throw new Error('Frame not found');
        return {
          sequenceTitle: frame.sequence.title,
          sceneTitle: frame.metadata?.metadata?.title,
        };
      });

      // Step 4: Upload video to storage
      const storageResult = await context.run('upload-to-storage', async () => {
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
      await context.run('update-frame', async () => {
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
          console.log(
            `[MotionWorkflow] Frame ${frameId} was deleted, skipping final update`
          );
          return;
        }

        try {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.video:progress',
            { frameId, status: 'completed', videoUrl: storageResult.url }
          );
        } catch (emitError) {
          console.error(
            `[MotionWorkflow] Failed to emit generation.video:progress for frame ${frameId}:`,
            emitError
          );
        }
      });

      // Step 6: Opt-in merge auto-trigger for callers that fan out motion
      // without their own subsequent merge invocation (e.g. smart-retry's
      // motion-retry path). N parallel motion workflows can each reach this
      // step near-simultaneously after the last frame lands; the content-
      // derived dedup ID makes QStash collapse the duplicates into a single
      // workflowRunId. Regenerating any frame's video changes the hash and
      // re-arms a fresh merge. See issue #690.
      await context.run('check-merge-trigger', async () => {
        if (!input.triggerMergeOnComplete) return;
        if (!input.sequenceId || !input.teamId || !input.userId) return;

        const allFrames = await scopedDb.frames.listBySequence(
          input.sequenceId
        );
        if (allFrames.length === 0) return;
        if (!allFrames.every((f) => f.videoStatus === 'completed')) return;

        const sorted = [...allFrames].sort(
          (a, b) => a.orderIndex - b.orderIndex
        );
        const { videoUrls, sourceFrameVideoHashes } =
          buildMergeVideoSourcesFromFrames(sorted);

        if (videoUrls.length !== allFrames.length) return;

        console.log(
          `[MotionWorkflow] All ${allFrames.length} frames complete, triggering merge workflow`
        );

        const mergeInput: MergeVideoWorkflowInput = {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId: input.sequenceId,
          videoUrls,
          sourceFrameVideoHashes,
        };

        const inputHash = await computeSequenceVideoHashFromDto(mergeInput);

        await triggerWorkflow('/merge-video', mergeInput, {
          deduplicationId: `merge-${input.sequenceId}-${inputHash.slice(0, 16)}`,
          label: buildWorkflowLabel(input.sequenceId),
        });
      });
    }

    // Return the video URL and duration
    return { videoUrl, duration };
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);
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
          console.error(
            `[MotionWorkflow] Failed to emit generation.video:progress for frame ${input.frameId}:`,
            emitError
          );
        }
      }

      console.error(
        `[MotionWorkflow] Motion generation failed for frame ${input.frameId}: ${error}`
      );

      return `Motion generation failed for frame ${input.frameId}`;
    },
  }
);
