/**
 * Tests for the broad cron sweep — focused on the highest-risk paths:
 * the blind-fail passes (mass-mutation without QStash verification) and
 * pass isolation (one bad pass must not wedge the rest of the sweep).
 *
 * Drizzle is mocked at the call-chain level. We assert behaviour (which
 * call was made with what payload) rather than the generated SQL — that
 * keeps the tests robust to drizzle internals while still catching the
 * regressions the PR review called out (copy-paste of status literals,
 * wrong column on the update, missing pass isolation).
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  shotVariants,
  shots,
  sequenceElements,
  sequences,
} from '@/lib/db/schema';

type SchemaTable =
  | typeof shots
  | typeof shotVariants
  | typeof sequences
  | typeof sequenceElements;
type SetPayload = Record<string, Date | string>;
type UpdateCall = {
  table: SchemaTable;
  payload: SetPayload;
  returning: boolean;
};

const updateCalls: UpdateCall[] = [];
let limitArgs: number[] = [];

let stuckRows: Array<{ id: string; runId: string | null }> = [];
let blindFailReturning: Array<{ id: string }> = [];
let nextSelectThrows: Error | null = null;

const dbMock = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async (n: number) => {
          limitArgs.push(n);
          if (nextSelectThrows) {
            const err = nextSelectThrows;
            nextSelectThrows = null;
            throw err;
          }
          return stuckRows;
        },
      }),
    }),
  }),
  update: (table: SchemaTable) => ({
    set: (payload: SetPayload) => ({
      // The real `.where(condition)` returns a thenable that also exposes
      // `.returning(...)`. Per-row updates `await` it; blind-fail passes call
      // `.returning(...)` instead. Our mock supports both shapes — the
      // thenable is intentional here.
      where: () => ({
        // oxlint-disable-next-line no-thenable -- mocking drizzle's chain
        then(resolve: (value: undefined) => void) {
          updateCalls.push({ table, payload, returning: false });
          resolve(undefined);
        },
        returning: async () => {
          updateCalls.push({ table, payload, returning: true });
          return blindFailReturning;
        },
      }),
    }),
  }),
};

vi.doMock('#db-client', () => ({ getDb: () => dbMock }));

// resolveRunState stub: defaults to "still in flight" (null) — verified
// passes are no-ops unless a test overrides `runStateResult`.
let runStateResult: 'failed' | 'completed' | 'unknown' | null = null;
vi.doMock('@/lib/workflow/reconcile', () => ({
  resolveRunState: async () => runStateResult,
  STALE_THRESHOLD_MS: 5 * 60 * 1000,
}));

beforeEach(() => {
  updateCalls.length = 0;
  limitArgs = [];
  stuckRows = [];
  blindFailReturning = [];
  nextSelectThrows = null;
  runStateResult = null;
});

describe('reconcileAllStuckJobs — blind-fail passes', () => {
  test('sequences.music writes musicStatus=failed', async () => {
    blindFailReturning = [{ id: 'seq_1' }];
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    const counts = await reconcileAllStuckJobs();

    const musicUpdate = updateCalls.find(
      (c) => c.table === sequences && 'musicStatus' in c.payload
    );
    expect(musicUpdate).toBeDefined();
    expect(musicUpdate?.payload.musicStatus).toBe('failed');
    expect(musicUpdate?.returning).toBe(true);
    expect(counts['sequences.music']).toBe(1);
  });

  test('sequence_elements.vision writes visionStatus=failed', async () => {
    blindFailReturning = [{ id: 'el_1' }];
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    await reconcileAllStuckJobs();

    const visionUpdate = updateCalls.find(
      (c) => c.table === sequenceElements && 'visionStatus' in c.payload
    );
    expect(visionUpdate).toBeDefined();
    expect(visionUpdate?.payload.visionStatus).toBe('failed');
  });

  test('update payloads do NOT bump updated_at (so sequential passes still see the row as stale)', async () => {
    blindFailReturning = [{ id: 'seq_1' }];
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    await reconcileAllStuckJobs();

    for (const call of updateCalls) {
      expect('updatedAt' in call.payload).toBe(false);
    }
  });
});

describe('reconcileAllStuckJobs — pass isolation', () => {
  test('a throwing select in one pass does not stop later passes', async () => {
    nextSelectThrows = new Error('simulated D1 outage');
    blindFailReturning = [{ id: 'seq_1' }];
    const { reconcileAllStuckJobs, PASS_ERRORED } =
      await import('./reconcile-all');

    const counts = await reconcileAllStuckJobs();

    expect(counts['shots.thumbnail']).toBe(PASS_ERRORED);
    expect(counts['sequences.music']).toBeGreaterThan(0);
    expect(counts['sequence_elements.vision']).toBeGreaterThan(0);
  });
});

describe('reconcileAllStuckJobs — run-id-verified passes', () => {
  test('caps stuck-row selection at MAX_ROWS_PER_PASS (100) per verified pass', async () => {
    const { reconcileAllStuckJobs } = await import('./reconcile-all');
    await reconcileAllStuckJobs();
    // 7 verified passes: 4 shots + 2 shot_variants + sequences.status.
    expect(limitArgs.filter((n) => n === 100)).toHaveLength(7);
  });

  test('in-flight instance (resolveRunState null) → no per-row update on verified tables', async () => {
    stuckRows = [{ id: 'frm_1', runId: 'wf_running' }];
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    await reconcileAllStuckJobs();

    const verifiedTables: SchemaTable[] = [shots, shotVariants, sequences];
    const verifiedUpdates = updateCalls.filter(
      (c) => verifiedTables.includes(c.table) && !('musicStatus' in c.payload) // sequences.music is blind-fail, not verified
    );
    expect(verifiedUpdates).toHaveLength(0);
  });

  test("status lookup failed (resolveRunState 'unknown') → no per-row update on verified tables", async () => {
    stuckRows = [{ id: 'frm_1', runId: 'wf_unreachable' }];
    runStateResult = 'unknown';
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    await reconcileAllStuckJobs();

    const verifiedTables: SchemaTable[] = [shots, shotVariants, sequences];
    const verifiedUpdates = updateCalls.filter(
      (c) => verifiedTables.includes(c.table) && !('musicStatus' in c.payload) // sequences.music is blind-fail, not verified
    );
    expect(verifiedUpdates).toHaveLength(0);
  });
});

describe('reconcileAllStuckJobs — sequences.status pass (#839)', () => {
  test('dead storyboard run → status=failed with a retryable statusError', async () => {
    stuckRows = [{ id: 'seq_1', runId: 'openstory-so_storyboard_dead' }];
    runStateResult = 'failed';
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    const counts = await reconcileAllStuckJobs();

    const statusUpdate = updateCalls.find(
      (c) => c.table === sequences && c.payload.status === 'failed'
    );
    expect(statusUpdate).toBeDefined();
    expect(statusUpdate?.payload.statusError).toMatch(/Retry/);
    expect(counts['sequences.status']).toBeGreaterThan(0);
  });

  test('completed storyboard run → status=completed', async () => {
    stuckRows = [{ id: 'seq_1', runId: 'openstory-so_storyboard_done' }];
    runStateResult = 'completed';
    const { reconcileAllStuckJobs } = await import('./reconcile-all');

    await reconcileAllStuckJobs();

    const statusUpdate = updateCalls.find(
      (c) => c.table === sequences && c.payload.status === 'completed'
    );
    expect(statusUpdate).toBeDefined();
    expect('statusError' in (statusUpdate?.payload ?? {})).toBe(false);
  });
});
