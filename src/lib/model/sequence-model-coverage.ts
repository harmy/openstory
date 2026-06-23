import type { ModelGenerationStatus } from '@/components/model/base-model-selector';
import type { ShotVariant } from '@/lib/db/schema';
import type { VariantType } from '@/lib/db/schema/shot-variants';

/**
 * Sequence-wide generation coverage for one model (#547). Drives the header
 * image/video dropdown markers — "has this model generated across the whole
 * sequence yet, and is it the live primary".
 */
export type ModelCoverage = {
  /**
   * Per-model marker: `set` (live primary), `completed` (generated for ≥1
   * scene), `generating` (≥1 row pending or in flight, none completed yet —
   * `pending` rows fold into this so a just-added model reads as generating),
   * `failed`, or `pending` (nothing yet).
   */
  status: ModelGenerationStatus;
  /** Distinct scenes with a completed variant for this model. */
  completed: number;
  /**
   * Coverage denominator: scenes covered by ANY model of this type — the union
   * of every model's *completed* scenes (in-flight/failed rows don't count, so
   * `total` is 0 until at least one model completes a scene). A model is "fully
   * generated" when `completed === total`.
   */
  total: number;
};

/**
 * Build a per-model coverage map for a sequence from its `frame_variants` rows
 * of one type. Only primary rows count (divergent/discarded alternates are
 * excluded). The live primary model (when supplied) is marked `set`; every
 * other model reports how many scenes it has generated for so the dropdown can
 * show e.g. "8/10" while an added model is still filling in.
 */
export function computeSequenceModelCoverage(opts: {
  variants: readonly ShotVariant[] | undefined;
  variantType: VariantType;
  /** The live primary model (marked `set`), if any. */
  primaryModel?: string | null;
}): Map<string, ModelCoverage> {
  const { variants, variantType, primaryModel } = opts;
  const map = new Map<string, ModelCoverage>();
  if (!variants) return map;

  const completedFramesByModel = new Map<string, Set<string>>();
  const generating = new Set<string>();
  const failed = new Set<string>();
  const allCompletedFrames = new Set<string>();

  for (const v of variants) {
    if (v.variantType !== variantType) continue;
    if (v.divergedAt !== null || v.discardedAt !== null) continue;
    if (v.status === 'completed' && v.url) {
      let frames = completedFramesByModel.get(v.model);
      if (!frames) {
        frames = new Set();
        completedFramesByModel.set(v.model, frames);
      }
      frames.add(v.shotId);
      allCompletedFrames.add(v.shotId);
    } else if (v.status === 'generating' || v.status === 'pending') {
      generating.add(v.model);
    } else if (v.status === 'failed') {
      failed.add(v.model);
    }
  }

  const total = allCompletedFrames.size;
  const models = new Set<string>([
    ...completedFramesByModel.keys(),
    ...generating,
    ...failed,
  ]);
  if (primaryModel) models.add(primaryModel);

  for (const model of models) {
    const completed = completedFramesByModel.get(model)?.size ?? 0;
    let status: ModelGenerationStatus;
    if (model === primaryModel) {
      status = 'set';
    } else if (completed > 0) {
      status = 'completed';
    } else if (generating.has(model)) {
      status = 'generating';
    } else if (failed.has(model)) {
      status = 'failed';
    } else {
      status = 'pending';
    }
    map.set(model, { status, completed, total });
  }

  return map;
}
