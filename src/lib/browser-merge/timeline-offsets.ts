/**
 * Pure scene-timeline arithmetic. Extracted from `merge-sequence.ts` so the
 * unit test exercises the same code path that runs in production (rather than
 * a re-implementation that drifts silently from the merger).
 *
 * Inputs are per-scene durations measured from the encoded video tracks
 * (NOT `frame.durationMs` — see issue #638 Q1).
 */

export type SceneTimeline = {
  /** Cumulative start offset for each scene, in seconds. */
  offsets: number[];
  /** Sum of all scene durations, in seconds. */
  total: number;
};

export function computeSceneOffsets(durations: number[]): SceneTimeline {
  const offsets: number[] = [];
  let acc = 0;
  for (const d of durations) {
    offsets.push(acc);
    acc += d;
  }
  return { offsets, total: acc };
}
