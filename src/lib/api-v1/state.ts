/**
 * The shared "state document" for a sequence — the single representation the
 * status endpoint returns today, and the same shape the phase-2 SSE stream and
 * webhook payloads will carry. It is derived from the DB (authoritative), so it
 * is correct even when the realtime channel has expired or a client never
 * subscribed. Keyed-by-id frame entries make it trivially mergeable with the
 * out-of-order realtime deltas a stream would later apply.
 */

import type { ScopedDb } from '@/lib/db/scoped';
import type { Frame } from '@/lib/db/schema/frames';
import { FRAME_GENERATION_STATUSES } from '@/lib/db/schema/frames';
import type { Style } from '@/lib/db/schema/libraries';
import type { MusicStatus, SequenceStatus } from '@/lib/db/schema/sequences';
import { toShareableUrl } from '@/lib/storage/buckets';
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

export type SequenceCounts = {
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

/** The style a sequence was generated with — the UI's `styleId` filter value
 * plus its human-readable name (what the UI search matches on). `name` is null
 * only if the referenced style row is somehow gone. */
type SequenceStyle = {
  id: string;
  name: string | null;
};

/** The models a sequence was generated with — the raw ids the UI filters/sorts
 * on (script analysis + per-frame image + per-frame video, and the optional
 * music model). */
type SequenceModels = {
  analysis: string;
  image: string;
  video: string;
  music: string | null;
};

/**
 * The scalar fields shared by the single-sequence status document and each
 * entry of the `GET /api/v1/sequences` list page — everything except the
 * per-frame array. Built once in `buildSequenceSummary` so the two documents
 * can't drift.
 */
export type SequenceSummary = {
  id: string;
  title: string;
  status: SequenceStatus;
  statusError: string | null;
  aspectRatio: string;
  style: SequenceStyle;
  models: SequenceModels;
  createdAt: string;
  updatedAt: string;
  poster: { url: string } | null;
  music: { status: MusicStatus; url: string | null };
  counts: SequenceCounts;
};

export type SequenceState = SequenceSummary & {
  frames: SequenceStateFrame[];
};

/** The image URL a frame exposes once its still is ready (else null). */
function frameImageUrl(frame: Frame): string | null {
  // Frames track video status explicitly; image readiness is signalled by the
  // presence of a thumbnail URL (the stored R2 url, else the fast preview CDN
  // url).
  return frame.thumbnailUrl ?? frame.previewThumbnailUrl ?? null;
}

/**
 * Readiness tallies over a sequence's frames — the single source of truth for
 * the `counts` block shared by the status document and the list summary.
 */
export function summarizeFrameCounts(frames: Frame[]): SequenceCounts {
  let imagesReady = 0;
  let videosReady = 0;
  let videosFailed = 0;
  for (const frame of frames) {
    if (frameImageUrl(frame) !== null) imagesReady += 1;
    if (frame.videoStatus === 'completed') videosReady += 1;
    if (frame.videoStatus === 'failed') videosFailed += 1;
  }
  return { frames: frames.length, imagesReady, videosReady, videosFailed };
}

/**
 * Build the scalar summary fields shared by the status document and each list
 * entry. `style` is the sequence's resolved style row (null if it couldn't be
 * loaded — the `id` is still surfaced). `origin` absolutizes stored media URLs
 * (see `buildSequenceState`).
 */
export function buildSequenceSummary(params: {
  sequence: Sequence;
  style: Style | null;
  counts: SequenceCounts;
  origin: string;
}): SequenceSummary {
  const { sequence, style, counts, origin } = params;
  const share = (url: string | null): string | null =>
    url === null ? null : toShareableUrl(url, origin);

  return {
    id: sequence.id,
    title: sequence.title,
    status: sequence.status,
    statusError: sequence.statusError ?? null,
    aspectRatio: sequence.aspectRatio,
    style: { id: sequence.styleId, name: style?.name ?? null },
    models: {
      analysis: sequence.analysisModel,
      image: sequence.imageModel,
      video: sequence.videoModel,
      music: sequence.musicModel ?? null,
    },
    createdAt: sequence.createdAt.toISOString(),
    updatedAt: sequence.updatedAt.toISOString(),
    poster: sequence.posterUrl
      ? { url: toShareableUrl(sequence.posterUrl, origin) }
      : null,
    music: {
      status: sequence.musicStatus ?? 'pending',
      url: share(sequence.musicUrl ?? null),
    },
    counts,
  };
}

export async function buildSequenceState(
  scopedDb: {
    frames: Pick<ScopedDb['frames'], 'listBySequence'>;
    styles: Pick<ScopedDb['styles'], 'getById'>;
  },
  sequence: Sequence,
  // Scheme+host the request arrived on. Stored media URLs are origin-relative
  // (#894); the API hands them to off-origin clients, so absolutize them to a
  // shareable form (CDN domain when configured, else this origin). See
  // toShareableUrl.
  origin: string
): Promise<SequenceState> {
  const [frames, style] = await Promise.all([
    scopedDb.frames.listBySequence(sequence.id),
    scopedDb.styles.getById(sequence.styleId),
  ]);
  const ordered = [...frames].sort((a, b) => a.orderIndex - b.orderIndex);
  const share = (url: string | null): string | null =>
    url === null ? null : toShareableUrl(url, origin);

  const stateFrames: SequenceStateFrame[] = ordered.map((frame) => {
    const imageUrl = frameImageUrl(frame);
    return {
      id: frame.id,
      orderIndex: frame.orderIndex,
      title: frame.metadata?.metadata?.title ?? null,
      image: {
        status: imageUrl ? 'completed' : 'pending',
        url: share(imageUrl),
      },
      video: {
        status: frame.videoStatus ?? 'pending',
        url: share(frame.videoUrl ?? null),
      },
    };
  });

  return {
    ...buildSequenceSummary({
      sequence,
      style,
      counts: summarizeFrameCounts(ordered),
      origin,
    }),
    frames: stateFrames,
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
