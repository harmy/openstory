/**
 * Lazy reconciliation for stale frame statuses.
 *
 * When frames are stuck in 'generating' for >5 minutes, we check QStash
 * to see if the workflow actually finished (success/fail/canceled).
 * If so, we update the DB to reflect reality.
 *
 * Called as fire-and-forget when frames are loaded — doesn't block responses.
 */

import type { Frame } from '@/lib/db/schema';
import { getWorkflowClient } from './client';
import type { WorkflowRunState } from './status';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

type StatusField = 'thumbnailStatus' | 'videoStatus' | 'variantImageStatus';

type RunIdField =
  | 'thumbnailWorkflowRunId'
  | 'videoWorkflowRunId'
  | 'variantWorkflowRunId';

const STATUS_TO_RUN_ID_FIELD: Record<StatusField, RunIdField> = {
  thumbnailStatus: 'thumbnailWorkflowRunId',
  videoStatus: 'videoWorkflowRunId',
  variantImageStatus: 'variantWorkflowRunId',
};

type FrameUpdater = {
  update: (
    frameId: string,
    data: Record<string, string | Date>,
    options?: { throwOnMissing?: boolean }
  ) => Promise<Frame | undefined>;
};

/**
 * Check frames stuck in 'generating' for >5 minutes against QStash.
 * If the workflow is no longer running, mark the frame as 'failed'.
 *
 * @param frameList - frames to check
 * @param framesDb - scopedDb.frames (or equivalent with .update method)
 */
export async function reconcileStaleFrameStatuses(
  frameList: Frame[],
  framesDb: FrameUpdater
): Promise<void> {
  const now = Date.now();

  // Collect all stale (frameId, statusField) pairs
  const staleEntries: Array<{ frame: Frame; field: StatusField }> = [];

  for (const frame of frameList) {
    const updatedAtMs = frame.updatedAt.getTime();
    if (now - updatedAtMs < STALE_THRESHOLD_MS) continue;

    const statusFields: StatusField[] = [
      'thumbnailStatus',
      'videoStatus',
      'variantImageStatus',
    ];
    for (const field of statusFields) {
      if (frame[field] === 'generating') {
        staleEntries.push({ frame, field });
      }
    }
  }

  // Fast path: nothing stale
  if (staleEntries.length === 0) return;

  const client = getWorkflowClient();

  // Query QStash for each stale workflow and reconcile
  for (const { frame, field } of staleEntries) {
    const runIdField = STATUS_TO_RUN_ID_FIELD[field];
    const runId = frame[runIdField] ?? '';

    if (runId === '') {
      // No stored run ID — workflow was never tracked properly
      await framesDb.update(
        frame.id,
        { [field]: 'failed', updatedAt: new Date() },
        { throwOnMissing: false }
      );
      continue;
    }

    try {
      const { runs } = await client.logs({ workflowRunId: runId, count: 1 });
      const run = runs[0];

      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!run) {
        // No record in QStash — workflow never ran or was cleaned up
        await framesDb.update(
          frame.id,
          { [field]: 'failed', updatedAt: new Date() },
          { throwOnMissing: false }
        );
        continue;
      }

      const state: WorkflowRunState = run.workflowState;

      if (state === 'RUN_FAILED' || state === 'RUN_CANCELED') {
        await framesDb.update(
          frame.id,
          { [field]: 'failed', updatedAt: new Date() },
          { throwOnMissing: false }
        );
      } else if (state === 'RUN_SUCCESS') {
        await framesDb.update(
          frame.id,
          { [field]: 'completed', updatedAt: new Date() },
          { throwOnMissing: false }
        );
      }
      // RUN_STARTED → still running, leave as 'generating'
    } catch (error) {
      // Don't let reconciliation errors propagate — this is best-effort
      console.error(
        `[reconcile] Failed to check workflow ${runId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
}
