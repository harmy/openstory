/**
 * Batch Motion + Music Workflow
 * Orchestrates parallel motion generation for all frames + optional music,
 * then merges videos and optionally muxes audio onto the final output.
 */

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
import { mergeVideoWorkflow } from './merge-video-workflow';
import { generateMotionWorkflow } from './motion-workflow';
import { generateMusicWorkflow } from './music-workflow';

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

      // Step 2: Collect video URLs from DB (authoritative order)
      const videoUrls = await context.run('collect-video-urls', async () => {
        const frames = await scopedDb.frames.listBySequence(sequenceId);
        return frames
          .sort((a, b) => a.orderIndex - b.orderIndex)
          .map((f) => f.videoUrl)
          .filter((url): url is string => Boolean(url));
      });

      if (videoUrls.length === 0) {
        throw new WorkflowValidationError(
          'No completed frame videos found after motion generation'
        );
      }

      // Step 3: Merge all frame videos into one
      await context.invoke('merge-video', {
        workflow: mergeVideoWorkflow,
        label,
        body: {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          videoUrls,
        } satisfies MergeVideoWorkflowInput,
      });

      // Step 4: If music was generated, mux audio onto merged video
      if (includeMusic) {
        // Get URLs from DB (authoritative, set by child workflows)
        const mergeAndMusicUrls = await context.run(
          'get-merge-music-urls',
          async () => {
            const seq = scopedDb.sequence(sequenceId);
            const [videoStatus, musicStatus] = await Promise.all([
              seq.getMergedVideoStatus(),
              seq.getMusicStatus(),
            ]);

            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
            if (!videoStatus?.mergedVideoUrl) {
              throw new Error('Merge completed but no merged video URL found');
            }
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
            if (!musicStatus?.musicUrl) {
              throw new Error('Music generation completed but no URL found');
            }

            return {
              mergedVideoUrl: videoStatus.mergedVideoUrl,
              musicUrl: musicStatus.musicUrl,
            };
          }
        );

        await context.invoke('merge-audio-video', {
          workflow: mergeAudioVideoWorkflow,
          label,
          body: {
            userId: input.userId,
            teamId: input.teamId,
            sequenceId,
            mergedVideoUrl: mergeAndMusicUrls.mergedVideoUrl,
            musicUrl: mergeAndMusicUrls.musicUrl,
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

        console.error(
          `[MotionBatchWorkflow] Failed for sequence ${input.sequenceId}: ${error}`
        );

        return `Batch motion+music failed for sequence ${input.sequenceId}`;
      },
    }
  );
