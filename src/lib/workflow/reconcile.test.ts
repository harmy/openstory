/**
 * Tests for the shared `resolveRunState` helper used by the cron sweep.
 * The on-load reconciler was removed in #727 — see `reconcile-all.test.ts`
 * for sweep-level behaviour.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { WorkflowRunState } from './status';

type LogsResult = {
  runs: ReadonlyArray<{ workflowState: WorkflowRunState }>;
};

const logsMock = vi.fn<
  (args: { workflowRunId: string; count: number }) => Promise<LogsResult>
>(async () => ({ runs: [] }));

vi.doMock('./client', () => ({
  getWorkflowClient: () => ({ logs: logsMock }),
}));

describe('resolveRunState', () => {
  beforeEach(() => {
    logsMock.mockReset();
  });

  test('returns "failed" when QStash reports RUN_CANCELED', async () => {
    logsMock.mockResolvedValueOnce({
      runs: [{ workflowState: 'RUN_CANCELED' }],
    });
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('run_1')).toBe('failed');
  });

  test('returns "failed" when QStash reports RUN_FAILED', async () => {
    logsMock.mockResolvedValueOnce({ runs: [{ workflowState: 'RUN_FAILED' }] });
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('run_2')).toBe('failed');
  });

  test('returns "completed" on RUN_SUCCESS', async () => {
    logsMock.mockResolvedValueOnce({
      runs: [{ workflowState: 'RUN_SUCCESS' }],
    });
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('run_3')).toBe('completed');
  });

  test('returns null on RUN_STARTED (still running, leave alone)', async () => {
    logsMock.mockResolvedValueOnce({
      runs: [{ workflowState: 'RUN_STARTED' }],
    });
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('run_4')).toBeNull();
  });

  test('returns null when QStash returns an empty runs array (safer: leave row alone)', async () => {
    // Conservative: an empty response could be a transient blip or a
    // not-yet-logged run. We'd rather skip and retry than falsely mark
    // a healthy row failed.
    logsMock.mockResolvedValueOnce({ runs: [] });
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('run_5')).toBeNull();
  });

  test('returns "failed" when runId is empty (workflow was never tracked)', async () => {
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('')).toBe('failed');
    expect(logsMock).not.toHaveBeenCalled();
  });

  test('swallows QStash errors and returns null (best-effort)', async () => {
    logsMock.mockRejectedValueOnce(new Error('network'));
    const { resolveRunState } = await import('./reconcile');
    expect(await resolveRunState('run_6')).toBeNull();
  });
});
