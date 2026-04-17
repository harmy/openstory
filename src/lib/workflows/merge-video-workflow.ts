/**
 * Merge Video Workflow
 * Stitches all frame videos into a single merged video for sequence playback
 */

import { usdToMicros } from '@/lib/billing/money';
import { getGenerationChannel } from '@/lib/realtime';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import { generateId } from '@/lib/db/id';
import { mergeVideos } from '@/lib/motion/merge-videos';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { MergeVideoWorkflowInput } from '@/lib/workflow/types';

export const mergeVideoWorkflow = createScopedWorkflow<MergeVideoWorkflowInput>(
  async (context, scopedDb) => {
    const input = context.requestPayload;

    if (!input.sequenceId) {
      throw new WorkflowValidationError('Sequence ID is required');
    }
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    if (!input.videoUrls || input.videoUrls.length === 0) {
      throw new WorkflowValidationError('At least one video URL is required');
    }

    const seq = scopedDb.sequence(input.sequenceId);

    console.log(
      `[MergeVideoWorkflow] Starting merge for sequence ${input.sequenceId} with ${input.videoUrls.length} videos`
    );

    // Single video: skip merge, use existing video directly
    if (input.videoUrls.length === 1) {
      const singleUrl = input.videoUrls[0];

      await context.run('update-sequence-single', async () => {
        await seq.updateMergedVideoFields({
          mergedVideoUrl: singleUrl,
          mergedVideoPath: null,
          mergedVideoStatus: 'completed',
          mergedVideoGeneratedAt: new Date(),
          mergedVideoError: null,
        });

        void getGenerationChannel(input.sequenceId).emit(
          'generation.merge:progress',
          { step: 'video', status: 'completed', mergedVideoUrl: singleUrl }
        );
      });

      return { mergedVideoUrl: singleUrl, mergedVideoPath: null };
    }

    await context.run('set-merging-status', async () => {
      await seq.updateMergedVideoFields({
        mergedVideoStatus: 'merging',
        mergedVideoError: null,
      });

      void getGenerationChannel(input.sequenceId).emit(
        'generation.merge:progress',
        { step: 'video', status: 'merging' }
      );
    });

    const mergeResult = await context.run('merge-videos', async () => {
      return mergeVideos({
        videoUrls: input.videoUrls,
        scopedDb,
      });
    });

    await context.run('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: usdToMicros(mergeResult.cost),
        usedOwnKey: mergeResult.metadata.usedOwnKey,
        description: `Video merge (${input.videoUrls.length} clips)`,
        metadata: { sequenceId: input.sequenceId },
        workflowName: 'MergeVideoWorkflow',
      });
    });

    const storageResult = await context.run('upload-to-storage', async () => {
      const response = await fetch(mergeResult.videoUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to download merged video: ${response.statusText}`
        );
      }

      const extension = getExtensionFromUrl(mergeResult.videoUrl) || 'mp4';
      const contentType = getMimeTypeFromExtension(extension);
      const shortHash = generateId().slice(-8);
      const path = `teams/${input.teamId}/sequences/${input.sequenceId}/merged/${shortHash}_openstory.${extension}`;

      const result = await uploadResponse(
        response,
        STORAGE_BUCKETS.VIDEOS,
        path,
        {
          contentType,
        }
      );

      return { path, url: result.publicUrl };
    });

    await context.run('update-sequence', async () => {
      await seq.updateMergedVideoFields({
        mergedVideoUrl: storageResult.url,
        mergedVideoPath: storageResult.path,
        mergedVideoStatus: 'completed',
        mergedVideoGeneratedAt: new Date(),
        mergedVideoError: null,
      });

      void getGenerationChannel(input.sequenceId).emit(
        'generation.merge:progress',
        {
          step: 'video',
          status: 'completed',
          mergedVideoUrl: storageResult.url,
        }
      );
    });

    console.log(
      `[MergeVideoWorkflow] Completed merge for sequence ${input.sequenceId}`
    );

    return {
      mergedVideoUrl: storageResult.url,
      mergedVideoPath: storageResult.path,
    };
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);
      if (input.sequenceId) {
        const failSeq = scopedDb.sequence(input.sequenceId);

        await failSeq.updateMergedVideoFields({
          mergedVideoStatus: 'failed',
          mergedVideoError: error,
        });

        void getGenerationChannel(input.sequenceId).emit(
          'generation.merge:progress',
          { step: 'video', status: 'failed' }
        );
      }
      console.error(
        `[MergeVideoWorkflow] Failed to merge sequence ${input.sequenceId}: ${error}`
      );

      return `Merge failed for sequence ${input.sequenceId}`;
    },
  }
);
