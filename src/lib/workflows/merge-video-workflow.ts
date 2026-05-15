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
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { ScopedDb } from '@/lib/db/scoped';
import type {
  MergeAudioVideoWorkflowInput,
  MergeVideoWorkflowInput,
} from '@/lib/workflow/types';
import type { WorkflowContext } from '@upstash/workflow';
import { mergeAudioVideoWorkflow } from './merge-audio-video-workflow';
import { resolveMusicVariantForMux } from './merge-variant-resolution';
import {
  computeSequenceVideoHashCurrent,
  computeSequenceVideoHashFromDto,
} from './sequence-snapshots';

export const MERGE_VIDEO_WORKFLOW_NAME = 'merge-video';

/**
 * Chain to merge-audio-video if the sequence has a ready music track.
 * This keeps the UI "Merge with Video" CTA honest — it restitches frames
 * and also muxes the existing music onto the fresh output.
 *
 * Both the merged video and the music are sourced as variants — `merge-audio-video`
 * accepts variant ids so the final output is a function of `(video, music)`.
 */
async function chainAudioMux(
  context: WorkflowContext<MergeVideoWorkflowInput>,
  scopedDb: ScopedDb,
  input: MergeVideoWorkflowInput & { sequenceId: string },
  mergedVideoVariantId: string
): Promise<void> {
  const musicVariantId = await context.run(
    'fetch-music-variant-for-mux',
    async () => resolveMusicVariantForMux(scopedDb, input.sequenceId)
  );

  if (!musicVariantId) {
    return;
  }

  await context.invoke('merge-audio-video', {
    workflow: mergeAudioVideoWorkflow,
    label: buildWorkflowLabel(input.sequenceId),
    body: {
      userId: input.userId,
      teamId: input.teamId,
      sequenceId: input.sequenceId,
      mergedVideoVariantId,
      musicVariantId,
    } satisfies MergeAudioVideoWorkflowInput,
  });
}

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

    const narrowedInput = { ...input, sequenceId: input.sequenceId };
    const seq = scopedDb.sequence(input.sequenceId);

    const inputHash = await context.run('compute-input-hash', async () => {
      console.log(
        `[MergeVideoWorkflow] Starting merge for sequence ${input.sequenceId} with ${input.videoUrls.length} videos`
      );
      return computeSequenceVideoHashFromDto(input);
    });

    // Single video: skip merge, use existing video directly
    if (input.videoUrls.length === 1) {
      const singleUrl = input.videoUrls[0];

      const currentHash = await context.run(
        'compute-current-hash-single',
        async () => computeSequenceVideoHashCurrent(input, scopedDb)
      );

      const writeResult = await context.run(
        'write-video-variant-single',
        async () => {
          return scopedDb.sequenceVariants.writeVideoVariant({
            sequenceId: narrowedInput.sequenceId,
            url: singleUrl,
            storagePath: null,
            workflow: MERGE_VIDEO_WORKFLOW_NAME,
            status: 'completed',
            generatedAt: new Date(),
            error: null,
            inputHash,
            currentHash,
          });
        }
      );

      if (writeResult.divergent) {
        // Divergent single-video result: prior primary on `sequences.merged*`
        // stays authoritative. We never set merging-status on the
        // single-video path, but emit a terminal event so any in-flight UI
        // spinner stops, plus a `stale:detected` for the divergent banner.
        const divergedVariantId = writeResult.variant.id;
        await context.run('emit-divergent-single', async () => {
          const channel = getGenerationChannel(narrowedInput.sequenceId);
          await channel.emit('generation.merge:progress', {
            step: 'video',
            status: 'completed',
          });
          await channel.emit('generation.stale:detected', {
            entityType: 'sequence',
            entityId: narrowedInput.sequenceId,
            artifact: 'merged-video',
            snapshotInputHash: inputHash,
            divergedVariantId,
          });
        });
        console.log(
          `[MergeVideoWorkflow] Diverged single-video result for sequence ${narrowedInput.sequenceId}; preserved as alternate (variant=${divergedVariantId})`
        );
        return { mergedVideoUrl: singleUrl, mergedVideoPath: null };
      }

      await context.run('update-sequence-single', async () => {
        await seq.updateMergedVideoFields({
          mergedVideoUrl: singleUrl,
          mergedVideoPath: null,
          mergedVideoStatus: 'completed',
          mergedVideoGeneratedAt: new Date(),
          mergedVideoError: null,
        });

        await getGenerationChannel(input.sequenceId).emit(
          'generation.merge:progress',
          { step: 'video', status: 'completed', mergedVideoUrl: singleUrl }
        );
      });

      await chainAudioMux(
        context,
        scopedDb,
        narrowedInput,
        writeResult.variant.id
      );
      return { mergedVideoUrl: singleUrl, mergedVideoPath: null };
    }

    await context.run('set-merging-status', async () => {
      await seq.updateMergedVideoFields({
        mergedVideoStatus: 'merging',
        mergedVideoError: null,
      });

      await getGenerationChannel(input.sequenceId).emit(
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

    const currentHash = await context.run('compute-current-hash', async () =>
      computeSequenceVideoHashCurrent(input, scopedDb)
    );

    const writeResult = await context.run('write-video-variant', async () => {
      return scopedDb.sequenceVariants.writeVideoVariant({
        sequenceId: narrowedInput.sequenceId,
        url: storageResult.url,
        storagePath: storageResult.path,
        workflow: MERGE_VIDEO_WORKFLOW_NAME,
        status: 'completed',
        generatedAt: new Date(),
        error: null,
        inputHash,
        currentHash,
      });
    });

    if (writeResult.divergent) {
      // Divergent merge: prior primary on `sequences.merged*` stays
      // authoritative. `set-merging-status` set mergedVideoStatus='merging'
      // earlier, so reset to 'completed' here and emit a terminal event so
      // the UI doesn't hang at 'merging'. The alternate is preserved in
      // `sequence_video_variants` for future surfacing.
      const divergedVariantId = writeResult.variant.id;
      await context.run('update-sequence-divergent', async () => {
        await seq.updateMergedVideoFields({
          mergedVideoStatus: 'completed',
          mergedVideoError: null,
        });

        const channel = getGenerationChannel(narrowedInput.sequenceId);
        await channel.emit('generation.merge:progress', {
          step: 'video',
          status: 'completed',
        });
        await channel.emit('generation.stale:detected', {
          entityType: 'sequence',
          entityId: narrowedInput.sequenceId,
          artifact: 'merged-video',
          snapshotInputHash: inputHash,
          divergedVariantId,
        });
      });
      console.log(
        `[MergeVideoWorkflow] Diverged merge result for sequence ${narrowedInput.sequenceId}; preserved as alternate (variant=${divergedVariantId})`
      );
      return {
        mergedVideoUrl: storageResult.url,
        mergedVideoPath: storageResult.path,
      };
    }

    await context.run('update-sequence', async () => {
      await seq.updateMergedVideoFields({
        mergedVideoUrl: storageResult.url,
        mergedVideoPath: storageResult.path,
        mergedVideoStatus: 'completed',
        mergedVideoGeneratedAt: new Date(),
        mergedVideoError: null,
      });

      await getGenerationChannel(input.sequenceId).emit(
        'generation.merge:progress',
        {
          step: 'video',
          status: 'completed',
          mergedVideoUrl: storageResult.url,
        }
      );
    });

    await chainAudioMux(
      context,
      scopedDb,
      narrowedInput,
      writeResult.variant.id
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

        try {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.merge:progress',
            { step: 'video', status: 'failed' }
          );
        } catch (emitError) {
          console.error(
            `[MergeVideoWorkflow] Failed to emit failure event for sequence ${input.sequenceId}:`,
            emitError
          );
        }
      }
      console.error(
        `[MergeVideoWorkflow] Failed to merge sequence ${input.sequenceId}: ${error}`
      );

      return `Merge failed for sequence ${input.sequenceId}`;
    },
  }
);
