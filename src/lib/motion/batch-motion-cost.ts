/**
 * Batch motion cost + model resolution (#909).
 *
 * Pulled out of `batchGenerateMotionFn` so the billing-critical per-shot
 * summation is unit-testable without a server-fn harness. Video model selection
 * lives at the scene level: an explicit batch model overrides everything, else
 * each shot's parent scene drives it, falling back to the sequence default.
 * Scenes may render with differently-priced models, so the batch cost is a sum
 * of per-shot costs — it can't collapse to `cost × count`.
 */

import {
  DEFAULT_VIDEO_MODEL,
  safeImageToVideoModel,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import { resolveSceneVideoModel } from '@/lib/ai/resolve-scene-models';
import { estimateVideoCost } from '@/lib/billing/cost-estimation';
import { addMicros, ZERO_MICROS, type Microdollars } from '@/lib/billing/money';
import { snapDuration } from '@/lib/motion/motion-generation';

type ShotSceneRef = { sceneId: string | null };
type SceneModelFields = { videoModel?: string | null };

/** Resolve the video model a single batch shot renders with (#909). */
export function resolveBatchShotVideoModel(
  shot: ShotSceneRef,
  scenesById: ReadonlyMap<string, SceneModelFields>,
  sequence: SceneModelFields,
  explicitModel?: string | null
): ImageToVideoModel {
  if (explicitModel) {
    return safeImageToVideoModel(explicitModel, DEFAULT_VIDEO_MODEL);
  }
  const scene = shot.sceneId ? (scenesById.get(shot.sceneId) ?? null) : null;
  return resolveSceneVideoModel(scene, sequence);
}

/**
 * Sum the estimated video cost for a batch of shots, pricing each shot with the
 * model its parent scene resolves to. Duration is snapped per resolved model so
 * the pre-flight estimate matches what the workflow ultimately bills.
 */
export function estimateBatchMotionCost(
  shots: ShotSceneRef[],
  scenesById: ReadonlyMap<string, SceneModelFields>,
  sequence: SceneModelFields,
  opts: { explicitModel?: string | null; duration?: number } = {}
): Microdollars {
  return shots.reduce((sum, shot) => {
    const model = resolveBatchShotVideoModel(
      shot,
      scenesById,
      sequence,
      opts.explicitModel
    );
    return addMicros(
      sum,
      estimateVideoCost(model, snapDuration(opts.duration, model))
    );
  }, ZERO_MICROS);
}
