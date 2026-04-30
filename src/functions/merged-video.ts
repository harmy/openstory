/**
 * Server functions backing the browser-side merge pipeline.
 *
 * Phase 1 of GitHub issue #638. The browser orchestrates the actual merge,
 * but the server still owns:
 *   - Authoritative status transitions on `sequences.mergedVideo*` columns.
 *   - Realtime `merge:progress` event emission (Upstash channel auth lives
 *     on the server).
 *   - Issuance of upload URLs scoped to the team's R2 path.
 *
 * Three thin handlers:
 *   - `requestMergedUploadUrlFn`  → reserves a path, flips status to 'merging',
 *                                   emits `step:'video', status:'merging'`.
 *   - `commitMergedVideoFn`       → verifies the uploaded object exists, writes
 *                                   the final URL/path, emits `step:'audio-video',
 *                                   status:'completed'`.
 *   - `failMergedVideoFn`         → records the failure + emits `status:'failed'`.
 */

import { getSignedUploadUrl } from '#storage';
import { generateId } from '@/lib/db/id';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { STORAGE_BUCKETS, getPublicUrl } from '@/lib/storage/buckets';
import { getGenerationChannel } from '@/lib/realtime';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { sequenceAccessMiddleware } from './middleware';

const MERGED_FILENAME_SUFFIX = '_openstory.mp4';
const MERGED_CONTENT_TYPE = 'video/mp4';

function buildMergedPath(teamId: string, sequenceId: string): string {
  const shortHash = generateId().slice(-8);
  return `teams/${teamId}/sequences/${sequenceId}/merged/${shortHash}${MERGED_FILENAME_SUFFIX}`;
}

function expectedPathPrefix(teamId: string, sequenceId: string): string {
  return `teams/${teamId}/sequences/${sequenceId}/merged/`;
}

/**
 * Reserve an R2 upload URL for the browser-merged MP4 and flip status to
 * 'merging'. The browser uses the returned `uploadUrl` (presigned PUT on
 * S3 deployments, same-origin proxy on Cloudflare) to stream the bytes.
 */
export const requestMergedUploadUrlFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    const path = buildMergedPath(context.teamId, context.sequence.id);
    const upload = await getSignedUploadUrl(
      STORAGE_BUCKETS.VIDEOS,
      path,
      MERGED_CONTENT_TYPE
    );

    await context.scopedDb
      .sequence(context.sequence.id)
      .updateMergedVideoFields({
        mergedVideoStatus: 'merging',
        mergedVideoError: null,
      });

    await emitMergeProgress(context.sequence.id, {
      step: 'video',
      status: 'merging',
    });

    return {
      uploadUrl: upload.uploadUrl,
      publicUrl: upload.publicUrl,
      path,
      contentType: MERGED_CONTENT_TYPE,
    };
  });

/**
 * Commit a successfully-uploaded merged MP4: verify the team-scoped path,
 * write the public URL into the sequence row, emit completion.
 *
 * `path` is the bucket-relative path returned from `requestMergedUploadUrlFn`
 * (i.e. `teams/.../merged/<hash>_openstory.mp4`, NOT prefixed with the bucket
 * name). We re-derive the public URL from the bucket + path on the server to
 * avoid trusting the client's reported URL.
 */
export const commitMergedVideoFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        path: z.string().min(1),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const expectedPrefix = expectedPathPrefix(
      context.teamId,
      context.sequence.id
    );
    if (!data.path.startsWith(expectedPrefix)) {
      throw new Error('Invalid merged-video path for this sequence/team');
    }
    if (!data.path.endsWith(MERGED_FILENAME_SUFFIX)) {
      throw new Error('Merged-video path must end with _openstory.mp4');
    }

    const publicUrl = getPublicUrl(STORAGE_BUCKETS.VIDEOS, data.path);

    await context.scopedDb
      .sequence(context.sequence.id)
      .updateMergedVideoFields({
        mergedVideoUrl: publicUrl,
        mergedVideoPath: data.path,
        mergedVideoStatus: 'completed',
        mergedVideoGeneratedAt: new Date(),
        mergedVideoError: null,
      });

    await emitMergeProgress(context.sequence.id, {
      step: 'audio-video',
      status: 'completed',
      mergedVideoUrl: publicUrl,
    });

    return { mergedVideoUrl: publicUrl, mergedVideoPath: data.path };
  });

/**
 * Record a browser-merge failure (capability probe failure, network error
 * mid-upload, encode failure, abort, etc.) and emit the matching realtime
 * event so the existing `theatre-view.tsx` failure branch can render.
 *
 * Guarded so a stale call cannot clobber a row that already reached
 * `'completed'` (e.g. server-side ffmpeg merge finished while the browser-side
 * pipeline was still attempting and then errored).
 */
export const failMergedVideoFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        error: z.string().max(500),
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (context.sequence.mergedVideoStatus !== 'merging') {
      console.warn(
        `failMergedVideoFn: ignoring failure for sequence ${context.sequence.id} in status "${context.sequence.mergedVideoStatus}"`
      );
      return { ok: false, reason: 'not-merging' as const };
    }

    console.error(
      `Browser merge failed for sequence ${context.sequence.id}: ${data.error}`
    );

    await context.scopedDb
      .sequence(context.sequence.id)
      .updateMergedVideoFields({
        mergedVideoStatus: 'failed',
        mergedVideoError: data.error,
      });

    await emitMergeProgress(context.sequence.id, {
      step: 'video',
      status: 'failed',
    });

    return { ok: true as const };
  });

type MergeProgressEvent =
  | { step: 'video'; status: 'merging' | 'failed' }
  | {
      step: 'audio-video';
      status: 'completed';
      mergedVideoUrl: string;
    };

/**
 * Emit a merge-progress event and surface (rather than swallow) realtime
 * failures: a silent emit failure leaves the client UI hung in 'merging' even
 * when the DB row is correct, so the only safe behavior is to log and let the
 * caller treat it as a hard error if they need at-least-once delivery.
 */
async function emitMergeProgress(
  sequenceId: string,
  event: MergeProgressEvent
): Promise<void> {
  try {
    await getGenerationChannel(sequenceId).emit(
      'generation.merge:progress',
      event
    );
  } catch (error) {
    console.error(
      `Failed to emit merge:progress for sequence ${sequenceId}`,
      error
    );
  }
}
