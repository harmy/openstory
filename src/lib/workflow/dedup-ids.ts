/**
 * Deterministic `deduplicationId` builders for child workflows triggered from
 * inside `step.do` closures (issue #846 RC2). Two invariants, both pinned by
 * dedup-ids.test.ts:
 *
 * 1. Replay-stable: a retried step must produce the identical id so the
 *    existing child instance is reused instead of spawning a second paid job.
 * 2. Run-scoping hash FIRST: `buildInstanceId` (instance-id.ts) keeps only
 *    `100 − prefix` chars of the suffix, truncating from the END, so the hash
 *    that separates two different runs must lead. Truncation may shear the
 *    human-readable tail, never the part that prevents a new run from
 *    colliding with (and silently reusing) a previous run's instance. If
 *    instance-id.ts ever changes its truncation strategy, revisit this.
 */

import { simpleHash } from '@/lib/utils/hash';

/**
 * Preview image spawned by SceneSplitWorkflow for a freshly upserted frame.
 * `shotId` is replay-stable (frames upsert on `(sequenceId, orderIndex)`);
 * the parent-instance hash scopes per run so a re-split still gets fresh
 * previews while a step retry can't re-spawn paid image jobs.
 */
export function previewImageDedupId(
  parentInstanceId: string,
  shotId: string
): string {
  return `preview-${simpleHash(parentInstanceId)}-${shotId}`;
}

/**
 * Shot-variant grid spawned by ShotImagesWorkflow, one per (frame, model) —
 * keyed on the scene id instead when no frame matched the scene.
 */
export function shotVariantDedupId(
  parentInstanceId: string,
  frameOrSceneId: string,
  model: string
): string {
  return `variant-${simpleHash(parentInstanceId)}-${frameOrSceneId}-${model}`;
}
