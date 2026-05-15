/**
 * Merge Audio+Video Workflow
 * Muxes a music track onto the merged video to produce the final sequence output
 */

import { composeAudioVideo } from '@/lib/audio/compose-audio-video';
import { normalizeAudioLoudness } from '@/lib/audio/loudness-normalize';
import { getGenerationChannel } from '@/lib/realtime';
import { usdToMicros } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import { generateId } from '@/lib/db/id';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { MergeAudioVideoWorkflowInput } from '@/lib/workflow/types';
import { resolveMergeAudioVideoSourceUrls } from './merge-variant-resolution';

export const mergeAudioVideoWorkflow = createScopedWorkflow<
  MergeAudioVideoWorkflowInput,
  { mergedVideoUrl: string; mergedVideoPath: string }
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;

    const { sequenceId, teamId, mergedVideoVariantId, musicVariantId } = input;
    if (!sequenceId || !teamId || !mergedVideoVariantId || !musicVariantId) {
      throw new WorkflowValidationError(
        'Sequence ID, mergedVideoVariantId, and musicVariantId are required'
      );
    }
    const seq = scopedDb.sequence(sequenceId);

    const sources = await context.run('resolve-variant-urls', async () =>
      resolveMergeAudioVideoSourceUrls(
        scopedDb,
        mergedVideoVariantId,
        musicVariantId
      )
    );
    const { mergedVideoUrl, musicUrl } = sources;

    await context.run('set-merging-status', async () => {
      console.log(
        `[MergeAudioVideoWorkflow] Starting mux for sequence ${sequenceId}`
      );
      await seq.updateMergedVideoFields({
        mergedVideoStatus: 'merging',
        mergedVideoError: null,
      });

      await getGenerationChannel(sequenceId).emit('generation.merge:progress', {
        step: 'audio-video',
        status: 'merging',
      });
    });

    const videoDurationMs = await context.run(
      'compute-video-duration',
      async () => {
        const frames = await scopedDb.frames.listBySequence(sequenceId);
        return frames.reduce((sum, f) => sum + (f.durationMs ?? 3000), 0);
      }
    );

    const normalizedMusicUrl = await context.run(
      'normalize-music-loudness',
      async () => {
        const result = await normalizeAudioLoudness({
          audioUrl: musicUrl,
          scopedDb,
        });
        return result.audioUrl;
      }
    );

    const muxResult = await context.run('compose-audio-video', async () => {
      return composeAudioVideo({
        videoUrl: mergedVideoUrl,
        musicUrl: normalizedMusicUrl,
        durationMs: videoDurationMs,
        scopedDb,
      });
    });

    await context.run('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: usdToMicros(muxResult.cost),
        usedOwnKey: muxResult.usedOwnKey,
        description: 'Audio+video mux',
        metadata: { sequenceId },
        workflowName: 'MergeAudioVideoWorkflow',
      });
    });

    const storageResult = await context.run('upload-to-storage', async () => {
      const response = await fetch(muxResult.videoUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to download muxed video: ${response.statusText}`
        );
      }

      const extension = getExtensionFromUrl(muxResult.videoUrl) || 'mp4';
      const contentType = getMimeTypeFromExtension(extension);
      const shortHash = generateId().slice(-8);
      const path = `teams/${teamId}/sequences/${sequenceId}/merged/${shortHash}_openstory.${extension}`;

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

      await getGenerationChannel(sequenceId).emit('generation.merge:progress', {
        step: 'audio-video',
        status: 'completed',
        mergedVideoUrl: storageResult.url,
      });
    });

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
            { step: 'audio-video', status: 'failed' }
          );
        } catch (emitError) {
          console.error(
            `[MergeAudioVideoWorkflow] Failed to emit failure event for sequence ${input.sequenceId}:`,
            emitError
          );
        }
      }
      console.error(
        `[MergeAudioVideoWorkflow] Failed to mux sequence ${input.sequenceId}: ${error}`
      );

      return `Audio+video mux failed for sequence ${input.sequenceId}`;
    },
  }
);
