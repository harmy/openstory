/**
 * N+M fan-out expansion for `MotionBatchWorkflow` (#545).
 *
 * Multi-model video generation runs one motion child per `(frame, model)` —
 * the motion analog of frame-images' per-`(scene, model)` fan-out. Pulled out
 * of the workflow body (mirroring `motion-workflow-persist`) so the expansion's
 * invariants are unit-testable without bootstrapping a `WorkflowEntrypoint`.
 *
 * Resolution rules (kept deliberately distinct from `resolveVideoModels`, which
 * has different defaulting):
 *   - top-level `videoModels` (deduped) applies to every frame when present;
 *   - otherwise each frame falls back to its own `model` (single-model paths);
 *   - a frame with neither falls back to `DEFAULT_VIDEO_MODEL`.
 *
 * Models are deduped per the top-level list so a model is never generated (or
 * billed) twice for the same frame, which also keeps the `(frameIndex, model)`
 * pair — and therefore each child's CF instance id — unique.
 */

import { DEFAULT_VIDEO_MODEL, type ImageToVideoModel } from '@/lib/ai/models';

export type MotionJob<F> = {
  shot: F;
  shotIndex: number;
  model: ImageToVideoModel;
};

export function buildMotionJobs<F extends { model?: ImageToVideoModel }>(
  shots: readonly F[],
  videoModels: readonly ImageToVideoModel[] | undefined
): MotionJob<F>[] {
  const topVideoModels =
    videoModels && videoModels.length > 0 ? [...new Set(videoModels)] : null;

  return shots.flatMap((shot, shotIndex) => {
    const models: ImageToVideoModel[] =
      topVideoModels ?? (shot.model ? [shot.model] : [DEFAULT_VIDEO_MODEL]);
    return models.map((model) => ({ shot, shotIndex, model }));
  });
}
