/**
 * The shared "state document" for a sequence — the single representation the
 * status endpoint returns today, and the same shape the phase-2 SSE stream and
 * webhook payloads will carry. It is derived from the DB (authoritative), so it
 * is correct even when the realtime channel has expired or a client never
 * subscribed. Keyed-by-id frame entries make it trivially mergeable with the
 * out-of-order realtime deltas a stream would later apply.
 */

import type { ScopedDb } from '@/lib/db/scoped';
import { FRAME_GENERATION_STATUSES } from '@/lib/db/schema/frames';
import type { MusicStatus, SequenceStatus } from '@/lib/db/schema/sequences';
import type { Sequence } from '@/types/database';
import { API_V1_BASE, type HalResource, waitLink, withLinks } from './hal';

type FrameGenStatus = (typeof FRAME_GENERATION_STATUSES)[number];

/** Sequence statuses past which no further generation happens. */
const TERMINAL_STATUSES = new Set<SequenceStatus>([
  'completed',
  'failed',
  'archived',
]);

type SequenceStateFrame = {
  id: string;
  orderIndex: number;
  title: string | null;
  image: { status: FrameGenStatus; url: string | null };
  video: { status: FrameGenStatus; url: string | null };
};

export type SequenceState = {
  id: string;
  title: string;
  status: SequenceStatus;
  statusError: string | null;
  aspectRatio: string;
  createdAt: string;
  updatedAt: string;
  poster: { url: string } | null;
  music: { status: MusicStatus; url: string | null };
  frames: SequenceStateFrame[];
  counts: {
    frames: number;
    imagesReady: number;
    videosReady: number;
    /**
     * Frames whose video generation failed. A sequence can reach the terminal
     * `completed` status with `videosFailed > 0` (per-frame motion failures
     * don't fail the run), so an agent must check this to know a terminal
     * result actually succeeded end-to-end.
     */
    videosFailed: number;
  };
};

export async function buildSequenceState(
  scopedDb: { frames: Pick<ScopedDb['frames'], 'listBySequence'> },
  sequence: Sequence
): Promise<SequenceState> {
  const frames = await scopedDb.frames.listBySequence(sequence.id);
  const ordered = [...frames].sort((a, b) => a.orderIndex - b.orderIndex);

  const stateFrames: SequenceStateFrame[] = ordered.map((frame) => {
    const imageUrl = frame.thumbnailUrl ?? frame.previewThumbnailUrl ?? null;
    return {
      id: frame.id,
      orderIndex: frame.orderIndex,
      title: frame.metadata?.metadata?.title ?? null,
      image: {
        // Frames track video status explicitly; image readiness is signalled by
        // the presence of a thumbnail URL.
        status: imageUrl ? 'completed' : 'pending',
        url: imageUrl,
      },
      video: {
        status: frame.videoStatus ?? 'pending',
        url: frame.videoUrl ?? null,
      },
    };
  });

  return {
    id: sequence.id,
    title: sequence.title,
    status: sequence.status,
    statusError: sequence.statusError ?? null,
    aspectRatio: sequence.aspectRatio,
    createdAt: sequence.createdAt.toISOString(),
    updatedAt: sequence.updatedAt.toISOString(),
    poster: sequence.posterUrl ? { url: sequence.posterUrl } : null,
    music: {
      status: sequence.musicStatus ?? 'pending',
      url: sequence.musicUrl ?? null,
    },
    frames: stateFrames,
    counts: {
      frames: stateFrames.length,
      imagesReady: stateFrames.filter((f) => f.image.status === 'completed')
        .length,
      videosReady: stateFrames.filter((f) => f.video.status === 'completed')
        .length,
      videosFailed: stateFrames.filter((f) => f.video.status === 'failed')
        .length,
    },
  };
}

/** True once a sequence can no longer change (completed / failed / archived). */
export function isTerminalSequenceState(state: SequenceState): boolean {
  return TERMINAL_STATUSES.has(state.status);
}

/**
 * A compact change-detection key for `?wait=` long-polling. It folds in every
 * field an agent polls for progress on, so the poll returns the instant any of
 * them advances — overall status, music, poster, per-kind ready counts, and
 * video failures (so a failing frame wakes the poll instead of stalling it
 * until the deadline).
 */
export function sequenceStateCursor(state: SequenceState): string {
  return [
    state.status,
    state.updatedAt,
    state.music.status,
    state.poster ? '1' : '0',
    state.counts.imagesReady,
    state.counts.videosReady,
    state.counts.videosFailed,
  ].join('|');
}

/** Attach the HAL affordance catalog (self + long-poll) to a sequence state. */
export function withSequenceStateLinks(
  state: SequenceState
): HalResource<SequenceState> {
  const href = `${API_V1_BASE}/sequences/${state.id}`;
  return withLinks(state, {
    self: { href, method: 'GET', title: 'Sequence status' },
    poll: waitLink(
      href,
      'Long-poll until this sequence changes (e.g. ?wait=60s)'
    ),
  });
}
