/**
 * Batch Motion + Music Workflow
 * Orchestrates parallel motion generation for all frames + optional music,
 * then merges videos and optionally muxes audio onto the final output.
 */

import { getGenerationChannel } from '@/lib/realtime';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  BatchMotionMusicWorkflowInput,
  MergeAudioVideoWorkflowInput,
  MergeVideoWorkflowInput,
  MotionWorkflowInput,
  MusicWorkflowInput,
} from '@/lib/workflow/types';

import { getFalFlowControl } from './constants';
import { mergeAudioVideoWorkflow } from './merge-audio-video-workflow';
import {
  MERGE_VIDEO_WORKFLOW_NAME,
  mergeVideoWorkflow,
} from './merge-video-workflow';
import { generateMotionWorkflow } from './motion-workflow';
import { generateMusicWorkflow } from './music-workflow';
import { resolveMotionBatchMergeMusicVariants } from './merge-variant-resolution';
import { buildMergeVideoSourcesFromFrames } from './sequence-snapshots';

export const motionBatchWorkflow =
  createScopedWorkflow<BatchMotionMusicWorkflowInput>(
    async (context, scopedDb) => {
      const input = context.requestPayload;
      const { sequenceId, includeMusic } = input;
      const label = buildWorkflowLabel(sequenceId);

      if (!sequenceId) {
        throw new WorkflowValidationError('sequenceId is required');
      }
      if (!input.frames.length) {
        throw new WorkflowValidationError('At least one frame is required');
      }
      if (includeMusic && !input.music) {
        throw new WorkflowValidationError(
          'music config is required when includeMusic is true'
        );
      }

      // Step 1: Invoke all motion workflows + optional music workflow in parallel
      const motionInvocations = input.frames.map((frame, index) =>
        context.invoke(`motion-${index}`, {
          workflow: generateMotionWorkflow,
          label,
          body: {
            userId: input.userId,
            teamId: input.teamId,
            frameId: frame.frameId,
            sequenceId,
            imageUrl: frame.imageUrl,
            prompt: frame.prompt,
            model: frame.model,
            duration: frame.duration,
            fps: frame.fps,
            motionBucket: frame.motionBucket,
            aspectRatio: frame.aspectRatio,
            generateAudio: frame.generateAudio,
            userEditedPrompt: frame.userEditedPrompt,
            // motion-batch invokes merge itself at step 3
            triggerMergeOnComplete: false,
          } satisfies MotionWorkflowInput,
          retries: 3,
          retryDelay: 'pow(2, retried) * 1000',
          flowControl: getFalFlowControl(),
        })
      );

      const musicInvocation =
        includeMusic && input.music
          ? context.invoke('music', {
              workflow: generateMusicWorkflow,
              label,
              body: {
                userId: input.userId,
                teamId: input.teamId,
                sequenceId,
                prompt: input.music.prompt,
                tags: input.music.tags,
                duration: input.music.duration,
                model: input.music.model,
              } satisfies MusicWorkflowInput,
              retries: 3,
              retryDelay: 'pow(2, retried) * 1000',
              flowControl: getFalFlowControl(),
            })
          : null;

      await Promise.all([
        Promise.all(motionInvocations),
        ...(musicInvocation ? [musicInvocation] : []),
      ]);

      // Step 2: Collect video URLs and inline each frame's videoInputHash for
      // the merge-video snapshot pattern. Frames without a videoUrl are skipped.
      const { videoUrls, sourceFrameVideoHashes } = await context.run(
        'collect-video-urls',
        async () => {
          const frames = await scopedDb.frames.listBySequence(sequenceId);
          const sorted = [...frames].sort(
            (a, b) => a.orderIndex - b.orderIndex
          );
          return buildMergeVideoSourcesFromFrames(sorted);
        }
      );

      if (videoUrls.length === 0) {
        throw new WorkflowValidationError(
          'No completed frame videos found after motion generation'
        );
      }

      // Step 3: Merge all frame videos into one
      await context.invoke(MERGE_VIDEO_WORKFLOW_NAME, {
        workflow: mergeVideoWorkflow,
        label,
        body: {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          videoUrls,
          sourceFrameVideoHashes,
        } satisfies MergeVideoWorkflowInput,
      });

      // Step 4: If music was generated, mux audio onto merged video.
      // Resolve both source variants — final mux is a function of (video, music).
      if (includeMusic) {
        const mergeAndMusicSources = await context.run(
          'get-merge-music-variants',
          async () =>
            resolveMotionBatchMergeMusicVariants(
              scopedDb,
              sequenceId,
              MERGE_VIDEO_WORKFLOW_NAME
            )
        );

        await context.invoke('merge-audio-video', {
          workflow: mergeAudioVideoWorkflow,
          label,
          body: {
            userId: input.userId,
            teamId: input.teamId,
            sequenceId,
            mergedVideoVariantId: mergeAndMusicSources.mergedVideoVariantId,
            musicVariantId: mergeAndMusicSources.musicVariantId,
          } satisfies MergeAudioVideoWorkflowInput,
        });
      }

      console.log(`[MotionBatchWorkflow] Completed for sequence ${sequenceId}`);

      return { sequenceId };
    },
    {
      failureFunction: async ({ context, failResponse }) => {
        const input = context.requestPayload;
        const error = sanitizeFailResponse(failResponse);

        if (input.sequenceId) {
          try {
            await getGenerationChannel(input.sequenceId).emit(
              'generation.failed',
              { message: error }
            );
          } catch (emitError) {
            console.error(
              `[MotionBatchWorkflow] Failed to emit generation.failed for sequence ${input.sequenceId}:`,
              emitError
            );
          }
        }

        console.error(
          `[MotionBatchWorkflow] Failed for sequence ${input.sequenceId}: ${error}`
        );

        return `Batch motion+music failed for sequence ${input.sequenceId}`;
      },
    }
  );
