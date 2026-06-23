/**
 * Tests for the storyboard launcher + generation mutex (#839).
 *
 * The mutex contract: a storyboard can never start while the sequence's
 * previous run is still in flight, two racing requests can't both win the
 * CAS claim, and the launcher owns the side effects (status write, run-id
 * persistence, deduplication id) so call sites can't drift apart.
 */

import { describe, expect, test, vi } from 'vitest';
import type { ScopedDb } from '@/lib/db/scoped';
import type { StoryboardWorkflowInput } from '@/lib/workflow/types';

const triggerWorkflowMock = vi.fn();
vi.doMock('@/lib/workflow/client', () => ({
  triggerWorkflow: triggerWorkflowMock,
}));

let runStateResult: 'failed' | 'completed' | 'unknown' | null = null;
vi.doMock('@/lib/workflow/reconcile', () => ({
  resolveRunState: vi.fn(async () => runStateResult),
}));

// Dynamic import so the mocks above apply (vi.doMock is not hoisted).
const {
  triggerStoryboard,
  assertNoActiveStoryboard,
  GenerationInProgressError,
  GenerationStatusUnknownError,
} = await import('./launchers');

const INPUT: StoryboardWorkflowInput = {
  userId: 'u1',
  teamId: 't1',
  sequenceId: 'seq_1',
  options: {
    shotsPerScene: 3,
    generateThumbnails: true,
    generateDescriptions: true,
    aiProvider: 'openrouter',
    regenerateAll: true,
  },
};

function makeScopedDb(opts: {
  workflowRunId: string | null;
  claimSucceeds?: boolean;
}) {
  const updateStatus = vi.fn();
  const claimWorkflowSlot = vi.fn<
    (params: {
      id: string;
      expectedRunId: string | null;
      claimId: string;
    }) => Promise<boolean>
  >(async () => opts.claimSucceeds ?? true);
  const update = vi.fn();
  const getForUser = vi.fn(async () => ({
    id: 'seq_1',
    workflowRunId: opts.workflowRunId,
    status: 'failed',
  }));
  const stub = {
    sequences: { getForUser, claimWorkflowSlot, update },
    sequence: () => ({ updateStatus }),
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal ScopedDb stub exposing only what the launcher touches
  const scopedDb = stub as unknown as ScopedDb;
  return { scopedDb, updateStatus, claimWorkflowSlot, update, getForUser };
}

describe('triggerStoryboard', () => {
  test('previous run still in flight → GenerationInProgressError, nothing triggered', async () => {
    runStateResult = null; // queued/running/waiting
    triggerWorkflowMock.mockReset();
    const { scopedDb, claimWorkflowSlot } = makeScopedDb({
      workflowRunId: 'openstory-so_storyboard_live',
    });

    await expect(triggerStoryboard(scopedDb, INPUT)).rejects.toBeInstanceOf(
      GenerationInProgressError
    );
    expect(claimWorkflowSlot).not.toHaveBeenCalled();
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
  });

  test('status lookup failed → GenerationStatusUnknownError (not "already running"), nothing triggered', async () => {
    runStateResult = 'unknown'; // CF status API blip — can't verify
    triggerWorkflowMock.mockReset();
    const { scopedDb, claimWorkflowSlot } = makeScopedDb({
      workflowRunId: 'openstory-so_storyboard_maybe',
    });

    await expect(triggerStoryboard(scopedDb, INPUT)).rejects.toBeInstanceOf(
      GenerationStatusUnknownError
    );
    expect(claimWorkflowSlot).not.toHaveBeenCalled();
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
  });

  test('terminal previous run → claims, triggers with the claim as dedup id, persists instance id', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    triggerWorkflowMock.mockResolvedValue('openstory-so_storyboard_new-run');
    const { scopedDb, claimWorkflowSlot, update, updateStatus } = makeScopedDb({
      workflowRunId: 'openstory-so_storyboard_old',
    });

    const result = await triggerStoryboard(scopedDb, INPUT);

    expect(claimWorkflowSlot).toHaveBeenCalledWith({
      id: 'seq_1',
      expectedRunId: 'openstory-so_storyboard_old',
      claimId: expect.stringMatching(/^storyboard-seq_1-/),
    });
    expect(updateStatus).toHaveBeenCalledWith('processing');
    const claimId = claimWorkflowSlot.mock.calls[0]?.[0]?.claimId;
    expect(triggerWorkflowMock).toHaveBeenCalledWith('/storyboard', INPUT, {
      deduplicationId: claimId,
      label: expect.any(String),
    });
    expect(update).toHaveBeenCalledWith({
      id: 'seq_1',
      workflowRunId: 'openstory-so_storyboard_new-run',
    });
    expect(result).toEqual({
      workflowRunId: 'openstory-so_storyboard_new-run',
    });
  });

  test('no previous run (fresh sequence) → claims against null without a status lookup', async () => {
    runStateResult = null; // would reject if consulted — it must not be
    triggerWorkflowMock.mockReset();
    triggerWorkflowMock.mockResolvedValue('run-1');
    const { scopedDb, claimWorkflowSlot } = makeScopedDb({
      workflowRunId: null,
    });

    await triggerStoryboard(scopedDb, INPUT);

    expect(claimWorkflowSlot).toHaveBeenCalledWith(
      expect.objectContaining({ expectedRunId: null })
    );
  });

  test('lost CAS race → GenerationInProgressError, nothing triggered', async () => {
    runStateResult = 'failed';
    triggerWorkflowMock.mockReset();
    const { scopedDb } = makeScopedDb({
      workflowRunId: 'openstory-so_storyboard_old',
      claimSucceeds: false,
    });

    await expect(triggerStoryboard(scopedDb, INPUT)).rejects.toBeInstanceOf(
      GenerationInProgressError
    );
    expect(triggerWorkflowMock).not.toHaveBeenCalled();
  });

  test('missing sequenceId → throws before touching the db', async () => {
    const { scopedDb, getForUser } = makeScopedDb({ workflowRunId: null });

    await expect(
      triggerStoryboard(scopedDb, { ...INPUT, sequenceId: undefined })
    ).rejects.toThrow('requires input.sequenceId');
    expect(getForUser).not.toHaveBeenCalled();
  });
});

describe('assertNoActiveStoryboard', () => {
  test('live run → throws', async () => {
    runStateResult = null;
    const { scopedDb } = makeScopedDb({
      workflowRunId: 'openstory-so_storyboard_live',
    });

    await expect(
      assertNoActiveStoryboard(scopedDb, 'seq_1')
    ).rejects.toBeInstanceOf(GenerationInProgressError);
  });

  test('status lookup failed → GenerationStatusUnknownError', async () => {
    runStateResult = 'unknown';
    const { scopedDb } = makeScopedDb({
      workflowRunId: 'openstory-so_storyboard_maybe',
    });

    await expect(
      assertNoActiveStoryboard(scopedDb, 'seq_1')
    ).rejects.toBeInstanceOf(GenerationStatusUnknownError);
  });

  test('terminal run → passes', async () => {
    runStateResult = 'completed';
    const { scopedDb } = makeScopedDb({
      workflowRunId: 'openstory-so_storyboard_done',
    });

    await expect(
      assertNoActiveStoryboard(scopedDb, 'seq_1')
    ).resolves.toBeUndefined();
  });

  test('no recorded run → passes (legacy rows)', async () => {
    runStateResult = null;
    const { scopedDb } = makeScopedDb({ workflowRunId: null });

    await expect(
      assertNoActiveStoryboard(scopedDb, 'seq_1')
    ).resolves.toBeUndefined();
  });
});
