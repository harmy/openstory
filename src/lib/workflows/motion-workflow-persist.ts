/**
 * Dual-write builders + persist orchestration for `MotionWorkflow` (#545).
 *
 * Motion generation writes each model's output in two places: the legacy
 * `shots.video*` columns (a last-write-wins default across models, kept so
 * single-model consumers and the "Mixed" player keep working) AND a per-model
 * `shot_variants` row (`variantType='video'`) that the scenes-view video-model
 * switcher resolves against.
 *
 * Pulled out of the workflow body — mirroring `image-workflow-snapshot.ts`'s
 * `persistImageResult` — so the generating → completed → failed state machine
 * is testable without bootstrapping a `WorkflowEntrypoint`. The workflow keeps
 * the `step.do` boundaries and the realtime-emit error handling; these helpers
 * own the write shapes and call sequence.
 */

import type { NewShot, NewShotVariant } from '@/lib/db/schema';
import type { VariantType } from '@/lib/db/schema/shot-variants';

export type MotionStorageResult = { url: string; path: string };

/**
 * Minimum scopedDb surface for the persist orchestrators. Production
 * `ScopedDb` is a structural superset and assigns cleanly; tests build literal
 * spies against this type without casting (same pattern as
 * `PersistImageScopedDb`).
 */
export type PersistMotionScopedDb = {
  shots: {
    update: (
      id: string,
      data: Partial<NewShot>,
      opts?: { throwOnMissing?: boolean }
    ) => Promise<{ id: string } | undefined>;
  };
  shotVariants: {
    updateByShotAndModel: (
      shotId: string,
      type: VariantType,
      model: string,
      data: Partial<NewShotVariant>
    ) => Promise<{ id: string } | null>;
    upsert: (data: NewShotVariant) => Promise<{ id: string }>;
  };
};

/**
 * Payload shape for `generation.video:progress`. A subset of the realtime
 * schema (see `src/lib/realtime/index.ts`) — assignable to the channel's
 * emitter so the workflow can forward it directly.
 */
export type MotionVideoProgressPayload =
  | {
      shotId: string;
      status: 'completed';
      videoUrl: string;
      model: string;
      // Variant-only (#547): added model — cache updater must not repoint the
      // primary video.
      variantOnly?: boolean;
    }
  | {
      shotId: string;
      status: 'failed';
      model: string;
      variantOnly?: boolean;
      // Failure reason so the cache updater writes `shots.videoError` live
      // (else the FailureSummaryBanner shows "Unknown error" until refetch). (#881)
      error?: string;
    };

export type MotionEmit = (
  event: 'generation.video:progress',
  payload: MotionVideoProgressPayload
) => Promise<void>;

type MotionWrites = {
  shot: Partial<NewShot>;
  variant: Partial<NewShotVariant>;
};

/**
 * `set-generating-status` writes: stamp the legacy columns with the model and
 * run id, and open this model's `shot_variants` row in `generating`.
 */
export function buildMotionGeneratingWrites(opts: {
  model: string;
  workflowRunId: string;
}): MotionWrites {
  return {
    shot: {
      videoStatus: 'generating',
      videoWorkflowRunId: opts.workflowRunId,
      motionModel: opts.model,
    },
    variant: {
      status: 'generating',
      workflowRunId: opts.workflowRunId,
    },
  };
}

/** Completed writes: stamp the final video onto both the legacy columns and
 *  this model's variant row, clearing any prior `videoError`. */
export function buildMotionCompletedWrites(opts: {
  upload: MotionStorageResult;
  durationMs: number;
  promptHash: string | null;
  generatedAt: Date;
}): MotionWrites {
  const { upload, durationMs, promptHash, generatedAt } = opts;
  return {
    shot: {
      videoPath: upload.path,
      videoUrl: upload.url,
      durationMs,
      videoStatus: 'completed',
      videoGeneratedAt: generatedAt,
      videoError: null,
    },
    variant: {
      url: upload.url,
      storagePath: upload.path,
      status: 'completed',
      generatedAt,
      error: null,
      durationMs,
      promptHash,
    },
  };
}

/** Failed writes: record the error on both the legacy columns and the variant. */
export function buildMotionFailedWrites(opts: { error: string }): MotionWrites {
  return {
    shot: {
      videoStatus: 'failed',
      videoError: opts.error,
    },
    variant: {
      status: 'failed',
      error: opts.error,
    },
  };
}

export type PersistMotionOutcome =
  | { status: 'completed'; videoUrl: string }
  | { status: 'shot-deleted' };

/**
 * Completed dual-write. Stamps the legacy `shots.video*` columns first; if the
 * shot was deleted mid-flight (`update` returns undefined) it short-circuits
 * without touching `shot_variants` or emitting — mirroring
 * `persistImageResult`. Otherwise updates this model's existing (generating)
 * variant row to `completed` and emits progress.
 *
 * `now` is injectable so tests can pin the `generatedAt` timestamp.
 */
export async function persistMotionCompletion(opts: {
  scopedDb: PersistMotionScopedDb;
  shotId: string;
  model: string;
  upload: MotionStorageResult;
  durationMs: number;
  promptHash: string | null;
  emit: MotionEmit;
  /**
   * Variant-only (#547): write only this model's `shot_variants` row, never
   * the legacy `shots.video*` columns — adding a video model leaves the
   * primary video intact.
   */
  variantOnly?: boolean;
  now?: () => Date;
}): Promise<PersistMotionOutcome> {
  const {
    scopedDb,
    shotId,
    model,
    upload,
    durationMs,
    promptHash,
    emit,
    variantOnly,
    now = () => new Date(),
  } = opts;

  const writes = buildMotionCompletedWrites({
    upload,
    durationMs,
    promptHash,
    generatedAt: now(),
  });

  if (variantOnly) {
    // Only this model's variant row; the primary `shots.video*` are untouched.
    // A null update means the shot (and its cascade-deleted variant) is gone.
    const updated = await scopedDb.shotVariants.updateByShotAndModel(
      shotId,
      'video',
      model,
      writes.variant
    );
    if (!updated) return { status: 'shot-deleted' };

    await emit('generation.video:progress', {
      shotId,
      status: 'completed',
      videoUrl: upload.url,
      model,
      // Alternate model — the cache updater must not repoint the primary.
      variantOnly: true,
    });

    return { status: 'completed', videoUrl: upload.url };
  }

  const updatedShot = await scopedDb.shots.update(shotId, writes.shot, {
    throwOnMissing: false,
  });
  if (!updatedShot) return { status: 'shot-deleted' };

  await scopedDb.shotVariants.updateByShotAndModel(
    shotId,
    'video',
    model,
    writes.variant
  );

  await emit('generation.video:progress', {
    shotId,
    status: 'completed',
    videoUrl: upload.url,
    model,
  });

  return { status: 'completed', videoUrl: upload.url };
}

/**
 * Failure dual-write (called from the workflow's `onFailure`). Records `failed`
 * on the legacy columns and on this model's variant row, then emits.
 *
 * Flips an *existing* variant row to `failed` via `updateByShotAndModel` —
 * which only touches `status`/`error`, so a previously-completed `url`/
 * `storagePath` is preserved (a re-run that fails before producing a new video
 * must not erase the last good one). Falls back to `upsert` only when no row
 * exists yet — e.g. a failure before `set-generating-status` ran (an
 * insufficient-credit throw in `check-credits`, or the top-level imageUrl
 * guard) — so the `failed` state is still visible in the scenes-view switcher.
 * (A blind `upsert` would set `url`/`storagePath` from the failure payload,
 * i.e. NULL, silently dropping the completed artifact.)
 */
export async function persistMotionFailure(opts: {
  scopedDb: PersistMotionScopedDb;
  shotId: string;
  sequenceId: string;
  model: string;
  error: string;
  workflowRunId: string;
  emit: MotionEmit;
  /** Variant-only (#547): record `failed` only on the variant, never the
   * legacy `shots.video*` columns. */
  variantOnly?: boolean;
}): Promise<void> {
  const {
    scopedDb,
    shotId,
    sequenceId,
    model,
    error,
    workflowRunId,
    emit,
    variantOnly,
  } = opts;

  const writes = buildMotionFailedWrites({ error });

  if (!variantOnly) {
    await scopedDb.shots.update(shotId, writes.shot, {
      throwOnMissing: false,
    });
  }

  const updated = await scopedDb.shotVariants.updateByShotAndModel(
    shotId,
    'video',
    model,
    writes.variant
  );
  if (!updated) {
    await scopedDb.shotVariants.upsert({
      shotId,
      sequenceId,
      variantType: 'video',
      model,
      workflowRunId,
      ...writes.variant,
    });
  }

  await emit('generation.video:progress', {
    shotId,
    status: 'failed',
    model,
    // Carry the reason so the cache updater writes `videoError` live (skip for
    // variant-only — the primary row isn't touched). (#881)
    ...(variantOnly ? {} : { error }),
    // A failed alternate must not flip the primary video to `failed` in cache.
    variantOnly,
  });
}
