/**
 * Tests for `deductWorkflowCredits` — in particular that the (now required)
 * `idempotencyKey` is forwarded to `scopedDb.billing.deductCredits`, since
 * that key is what makes a workflow-step replay charge-once (issue #846 RC1).
 */

import type { ScopedDb } from '@/lib/db/scoped';
import { describe, expect, it, vi } from 'vitest';
import { micros, ZERO_MICROS } from './money';
import { deductWorkflowCredits } from './workflow-deduction';

function makeScopedDb({ canAfford = true } = {}) {
  const deductCredits = vi.fn().mockResolvedValue({
    newBalance: micros(0),
    chargedAmount: micros(0),
    transactionId: 'tx1',
  });
  const hasEnoughCredits = vi.fn().mockResolvedValue(canAfford);
  const checkAutoTopUp = vi.fn().mockResolvedValue(undefined);
  const scopedDbStub = {
    billing: { deductCredits, hasEnoughCredits, checkAutoTopUp },
  };
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal ScopedDb stub exposing only the billing methods under test
  const scopedDb = scopedDbStub as unknown as ScopedDb;
  return { scopedDb, deductCredits, hasEnoughCredits, checkAutoTopUp };
}

describe('deductWorkflowCredits', () => {
  it('forwards the idempotencyKey to deductCredits', async () => {
    const { scopedDb, deductCredits } = makeScopedDb();

    await deductWorkflowCredits({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
      metadata: { frameId: 'f1' },
    });

    expect(deductCredits).toHaveBeenCalledTimes(1);
    expect(deductCredits).toHaveBeenCalledWith(micros(2_000_000), {
      description: 'Image generation (test-model)',
      metadata: { frameId: 'f1' },
      idempotencyKey: 'env_image_abc123:image',
    });
  });

  it('skips when the team used its own key', async () => {
    const { scopedDb, deductCredits } = makeScopedDb();

    await deductWorkflowCredits({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: true,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
    });

    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('skips for a zero cost', async () => {
    const { scopedDb, deductCredits } = makeScopedDb();

    await deductWorkflowCredits({
      scopedDb,
      costMicros: ZERO_MICROS,
      usedOwnKey: false,
      description: 'LLM analysis (model)',
      idempotencyKey: 'env_wf_abc123:llm-step',
    });

    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('skips without a scopedDb (anonymous workflow)', async () => {
    const { deductCredits } = makeScopedDb();

    await deductWorkflowCredits({
      scopedDb: undefined,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
    });

    expect(deductCredits).not.toHaveBeenCalled();
  });

  it('warns and skips (but still kicks auto-top-up) when credits are insufficient', async () => {
    const { scopedDb, deductCredits, checkAutoTopUp } = makeScopedDb({
      canAfford: false,
    });

    await deductWorkflowCredits({
      scopedDb,
      costMicros: micros(2_000_000),
      usedOwnKey: false,
      description: 'Image generation (test-model)',
      idempotencyKey: 'env_image_abc123:image',
      workflowName: 'ImageWorkflow',
    });

    expect(deductCredits).not.toHaveBeenCalled();
    expect(checkAutoTopUp).toHaveBeenCalledTimes(1);
  });
});
