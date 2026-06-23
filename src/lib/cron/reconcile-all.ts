/**
 * Broad reconciliation sweep for stuck generating-status rows.
 *
 * Driven by the Cloudflare Workers cron in `src/server.ts` (see
 * `wrangler.jsonc` `triggers.crons`). Scans every status-bearing table
 * directly and reconciles rows the user hasn't loaded — so idle accounts
 * get healed too. This is the only reconciler; the old on-load helper was
 * removed in #727.
 *
 * Two reconciliation shapes:
 *   A. Tables with a workflow_run_id column — query QStash, trust its truth
 *      (5min staleness threshold).
 *   B. Tables without a workflow_run_id column — blind-fail after a longer
 *      threshold (30min) because we can't verify run state.
 *
 * Each pass is capped at MAX_ROWS_PER_PASS to avoid hammering QStash if a
 * regression leaves many rows stuck.
 */

import { getDb } from '#db-client';
import {
  shots,
  shotVariants,
  sequenceElements,
  sequences,
} from '@/lib/db/schema';
import { resolveRunState, STALE_THRESHOLD_MS } from '@/lib/workflow/reconcile';
import { and, eq, isNotNull, lt } from 'drizzle-orm';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'cron', 'reconcile-all']);

const BLIND_FAIL_THRESHOLD_MS = 30 * 60 * 1000;
const MAX_ROWS_PER_PASS = 100;

type Database = ReturnType<typeof getDb>;
type ReconcileCounts = Record<string, number>;

/** Sentinel returned per pass in `ReconcileCounts` when the pass threw. */
export const PASS_ERRORED = -1;

/**
 * Top-level entry: run every pass sequentially. Errors in one pass don't stop
 * the others — the cron is best-effort. A failed pass records
 * `PASS_ERRORED` in the returned counts, distinguishable from a zero-update
 * pass.
 *
 * Always emits one summary log line per sweep so observability/alerting has a
 * single high-signal event per cron tick — without it, a systemic failure
 * (e.g. revoked QStash token making every per-row check throw) would look
 * identical to a clean sweep with nothing to do.
 */
export async function reconcileAllStuckJobs(): Promise<ReconcileCounts> {
  const db = getDb();
  const counts: ReconcileCounts = {};

  const passes: Array<[string, () => Promise<number>]> = [
    ['shots.thumbnail', () => reconcileShotsPass(db, 'thumbnail')],
    ['shots.video', () => reconcileShotsPass(db, 'video')],
    ['shots.variant_image', () => reconcileShotsPass(db, 'variantImage')],
    ['shots.audio', () => reconcileShotsPass(db, 'audio')],
    ['shot_variants.status', () => reconcileShotVariantsPass(db, 'primary')],
    [
      'shot_variants.shot_variant',
      () => reconcileShotVariantsPass(db, 'shotVariant'),
    ],
    ['sequences.status', () => reconcileSequencesPass(db)],
    ['sequences.music', () => blindFailPass(db, 'sequencesMusic')],
    ['sequence_elements.vision', () => blindFailPass(db, 'sequenceElements')],
  ];

  for (const [name, run] of passes) {
    try {
      counts[name] = await run();
    } catch (error) {
      logger.error(`${name} pass failed:`, {
        data: error instanceof Error ? error.message : error,
      });
      counts[name] = PASS_ERRORED;
    }
  }

  const failedPasses = Object.entries(counts)
    .filter(([, n]) => n === PASS_ERRORED)
    .map(([name]) => name);
  const totalReconciled = Object.values(counts)
    .filter((n) => n > 0)
    .reduce((sum, n) => sum + n, 0);

  if (failedPasses.length === passes.length) {
    logger.error('ALL passes failed', { counts });
  } else if (failedPasses.length > 0) {
    logger.warn('partial failure', { failedPasses, counts });
  } else if (totalReconciled > 0) {
    logger.info(`sweep complete: ${totalReconciled} row(s) reconciled`, {
      counts,
    });
  }

  return counts;
}

type ShotPipeline = 'thumbnail' | 'video' | 'variantImage' | 'audio';

// Why we don't bump `updatedAt` on reconciler writes (applies to every pass
// in this file): the staleness predicate is `updated_at < cutoff`. If pass A
// updated `updated_at = now` while writing its status column, pass B's
// SELECT for the same row would see a fresh timestamp and skip it. So when a
// shot is stuck across multiple pipelines simultaneously, only the first
// pass would reconcile. Leaving `updated_at` untouched lets sequential
// passes all see the row as stale until each one has flipped its own
// status column. The on-load reconciler doesn't have this issue because it
// collects all stale entries from in-memory data before writing.
const SHOTS_PIPELINE_COLUMNS = {
  thumbnail: {
    status: shots.thumbnailStatus,
    runId: shots.thumbnailWorkflowRunId,
    setStatus: (next: 'failed' | 'completed') => ({ thumbnailStatus: next }),
  },
  video: {
    status: shots.videoStatus,
    runId: shots.videoWorkflowRunId,
    setStatus: (next: 'failed' | 'completed') => ({ videoStatus: next }),
  },
  variantImage: {
    status: shots.variantImageStatus,
    runId: shots.variantWorkflowRunId,
    setStatus: (next: 'failed' | 'completed') => ({ variantImageStatus: next }),
  },
  audio: {
    status: shots.audioStatus,
    runId: shots.audioWorkflowRunId,
    setStatus: (next: 'failed' | 'completed') => ({ audioStatus: next }),
  },
} as const;

async function reconcileShotsPass(
  db: Database,
  pipeline: ShotPipeline
): Promise<number> {
  const cols = SHOTS_PIPELINE_COLUMNS[pipeline];
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const stuck = await db
    .select({ id: shots.id, runId: cols.runId })
    .from(shots)
    .where(and(eq(cols.status, 'generating'), lt(shots.updatedAt, staleCutoff)))
    .limit(MAX_ROWS_PER_PASS);

  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    // null = still in flight, 'unknown' = lookup failed — either way, don't
    // write a terminal status; the next sweep retries.
    if (next === null || next === 'unknown') continue;
    await db
      .update(shots)
      .set(cols.setStatus(next))
      .where(eq(shots.id, row.id));
    updated++;
  }
  return updated;
}

type ShotVariantsPipeline = 'primary' | 'shotVariant';

async function reconcileShotVariantsPass(
  db: Database,
  pipeline: ShotVariantsPipeline
): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const stuck =
    pipeline === 'primary'
      ? await db
          .select({ id: shotVariants.id, runId: shotVariants.workflowRunId })
          .from(shotVariants)
          .where(
            and(
              eq(shotVariants.status, 'generating'),
              lt(shotVariants.updatedAt, staleCutoff)
            )
          )
          .limit(MAX_ROWS_PER_PASS)
      : await db
          .select({
            id: shotVariants.id,
            runId: shotVariants.shotVariantWorkflowRunId,
          })
          .from(shotVariants)
          .where(
            and(
              eq(shotVariants.shotVariantStatus, 'generating'),
              lt(shotVariants.updatedAt, staleCutoff)
            )
          )
          .limit(MAX_ROWS_PER_PASS);

  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    if (pipeline === 'primary') {
      await db
        .update(shotVariants)
        .set({ status: next })
        .where(eq(shotVariants.id, row.id));
    } else {
      await db
        .update(shotVariants)
        .set({ shotVariantStatus: next })
        .where(eq(shotVariants.id, row.id));
    }
    updated++;
  }
  return updated;
}

/**
 * Heal sequences stuck in 'processing' whose /storyboard workflow died
 * without persisting an outcome (engine abort, waitForEvent timeout with a
 * pre-#839 log-only onFailure, eviction). Verified against the CF instance's
 * real status via the persisted `workflowRunId` — rows whose instance is
 * still in flight return `null` from `resolveRunState` and are left alone,
 * so a legitimately slow (multi-hour) generation is never falsely failed.
 *
 * Rows with a NULL `workflowRunId` (created before the column existed, or
 * whose trigger-site write failed) are skipped entirely: without a run id we
 * can't distinguish slow-but-alive from dead, and 'processing' has no safe
 * blind-fail threshold now that full runs can legitimately take hours.
 */
// Narrowly typed like SHOTS_PIPELINE_COLUMNS.setStatus so the compiler
// enforces the null/'unknown' skip in the loop below: dropping either guard
// makes this call fail typecheck instead of silently flipping a live (or
// unverifiable) sequence to 'completed'.
const setSequenceStatus = (next: 'failed' | 'completed') =>
  next === 'failed'
    ? {
        status: 'failed' as const,
        statusError: 'Generation was interrupted — use Retry to run it again.',
      }
    : { status: 'completed' as const };

async function reconcileSequencesPass(db: Database): Promise<number> {
  const staleCutoff = new Date(Date.now() - STALE_THRESHOLD_MS);

  const stuck = await db
    .select({ id: sequences.id, runId: sequences.workflowRunId })
    .from(sequences)
    .where(
      and(
        eq(sequences.status, 'processing'),
        isNotNull(sequences.workflowRunId),
        lt(sequences.updatedAt, staleCutoff)
      )
    )
    .limit(MAX_ROWS_PER_PASS);

  let updated = 0;
  for (const row of stuck) {
    const next = await resolveRunState(row.runId ?? '');
    if (next === null || next === 'unknown') continue;
    await db
      .update(sequences)
      .set(setSequenceStatus(next))
      .where(eq(sequences.id, row.id));
    updated++;
  }
  return updated;
}

type BlindFailPipeline = 'sequencesMusic' | 'sequenceElements';

/**
 * Tables without a workflow_run_id column: we can't ask QStash what happened.
 * After a longer threshold we mark them failed so the user can retry.
 *
 * Why 30min vs the 5min QStash-verified threshold: with no run id we can't
 * distinguish a slow-but-alive run from a dead one, so we wait long enough
 * that any reasonable workflow would have completed (the slowest current
 * workflows — music gen and element vision — finish well under 30min).
 * Note we can only flip to 'failed' here, never 'completed' — without a run
 * id, success requires the workflow's own update step to have persisted, and
 * if that didn't happen the artifact URL won't be there either.
 */
async function blindFailPass(
  db: Database,
  pipeline: BlindFailPipeline
): Promise<number> {
  const staleCutoff = new Date(Date.now() - BLIND_FAIL_THRESHOLD_MS);

  if (pipeline === 'sequencesMusic') {
    const result = await db
      .update(sequences)
      .set({ musicStatus: 'failed' })
      .where(
        and(
          eq(sequences.musicStatus, 'generating'),
          lt(sequences.updatedAt, staleCutoff)
        )
      )
      .returning({ id: sequences.id });
    return result.length;
  }

  // sequenceElements
  const result = await db
    .update(sequenceElements)
    .set({ visionStatus: 'failed' })
    .where(
      and(
        eq(sequenceElements.visionStatus, 'analyzing'),
        lt(sequenceElements.updatedAt, staleCutoff)
      )
    )
    .returning({ id: sequenceElements.id });
  return result.length;
}
