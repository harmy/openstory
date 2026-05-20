/**
 * Shared helper for resolving a stale workflow run via QStash.
 *
 * Used by the cron-driven sweep in `src/lib/cron/reconcile-all.ts`, which
 * is the single source of truth for healing rows stuck in 'generating' /
 * 'merging' / 'analyzing'. The previous on-load reconciler
 * (`reconcileStaleFrameStatuses`) was removed in #727 — it duplicated cron
 * work, doubled QStash query rate for stuck rows, and made `updated_at`
 * writes hard to reason about (two systems writing to the same row).
 */

import { getWorkflowClient } from './client';
import type { WorkflowRunState } from './status';

export const STALE_THRESHOLD_MS = 5 * 60 * 1000;

/**
 * Resolve a stale workflow run via QStash.
 *
 * Returns:
 *   - 'failed'    when the runId is empty (workflow was never tracked) or
 *                 QStash reports RUN_FAILED / RUN_CANCELED
 *   - 'completed' on RUN_SUCCESS
 *   - null        when the row should be left alone:
 *                   • RUN_STARTED (still running)
 *                   • QStash returned an empty `runs` array (could be a
 *                     transient blip or a not-yet-logged run — being
 *                     conservative beats falsely marking a healthy row failed)
 *                   • the QStash call threw (errors logged, not propagated,
 *                     so the cron stays best-effort)
 *
 * Callers should treat `null` as "skip and retry next sweep."
 */
export async function resolveRunState(
  runId: string
): Promise<'failed' | 'completed' | null> {
  if (runId === '') return 'failed';

  try {
    const client = getWorkflowClient();
    const { runs } = await client.logs({ workflowRunId: runId, count: 1 });
    const run = runs[0];

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: SDK type promises non-empty, but a transient API response with `runs: []` would silently mark a healthy row failed.
    if (!run) return null;

    const state: WorkflowRunState = run.workflowState;
    if (state === 'RUN_FAILED' || state === 'RUN_CANCELED') return 'failed';
    if (state === 'RUN_SUCCESS') return 'completed';
    return null;
  } catch (error) {
    console.error(
      `[reconcile] Failed to check workflow ${runId}:`,
      error instanceof Error ? error.message : error
    );
    return null;
  }
}
