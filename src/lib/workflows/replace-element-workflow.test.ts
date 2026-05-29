import { describe, expect, it } from 'vitest';
import {
  buildEditPrompt,
  decideBatchOutcome,
  type FrameResult,
  rejectionReasonMessage,
  settledToResult,
  shouldDowngradeVisionOnFailure,
} from './replace-element-workflow';

describe('buildEditPrompt', () => {
  it('includes the previous description in parens when present', () => {
    const prompt = buildEditPrompt({
      token: 'LOGO',
      newDescription: 'A blue square logo',
      previousDescription: 'A red hex logo',
    });
    expect(prompt).toContain('LOGO');
    expect(prompt).toContain('(previously: A red hex logo)');
    expect(prompt).toContain('New element description: A blue square logo');
  });

  it('omits the previous description clause when null', () => {
    const prompt = buildEditPrompt({
      token: 'BOTTLE',
      newDescription: 'Silver water bottle',
      previousDescription: null,
    });
    expect(prompt).toContain('BOTTLE');
    expect(prompt).not.toContain('previously:');
    expect(prompt).toContain('New element description: Silver water bottle');
  });

  it('omits the "New element description" line when description is empty', () => {
    const prompt = buildEditPrompt({
      token: 'WIDGET',
      newDescription: '',
      previousDescription: 'old widget',
    });
    expect(prompt).toContain('WIDGET');
    expect(prompt).toContain('(previously: old widget)');
    expect(prompt).not.toContain('New element description:');
  });
});

describe('decideBatchOutcome', () => {
  it('returns complete with zero counts when no frames ran (e.g. all skipped-deleted)', () => {
    const outcome = decideBatchOutcome([]);
    expect(outcome).toEqual({
      kind: 'complete',
      successCount: 0,
      failedCount: 0,
    });
  });

  it('throws-via-fail-kind when every attempted frame failed', () => {
    const results: FrameResult[] = [
      { frameId: 'f1', success: false, error: 'edit timeout' },
      { frameId: 'f2', success: false, error: 'no imageUrl' },
    ];
    const outcome = decideBatchOutcome(results);
    expect(outcome.kind).toBe('fail');
    if (outcome.kind !== 'fail') throw new Error('narrowing');
    expect(outcome.total).toBe(2);
    // Uses the first failure's reason as the sample for the thrown error.
    expect(outcome.sampleReason).toBe('edit timeout');
  });

  it('returns complete with mixed counts when some succeeded and some failed', () => {
    const results: FrameResult[] = [
      { frameId: 'f1', success: true, imageUrl: 'https://r2/a.png' },
      { frameId: 'f2', success: false, error: 'edit failed' },
      { frameId: 'f3', success: true, imageUrl: 'https://r2/c.png' },
    ];
    const outcome = decideBatchOutcome(results);
    expect(outcome).toEqual({
      kind: 'complete',
      successCount: 2,
      failedCount: 1,
    });
  });
});

describe('shouldDowngradeVisionOnFailure', () => {
  it('downgrades when vision was still in flight (analyzing)', () => {
    expect(shouldDowngradeVisionOnFailure('analyzing')).toBe(true);
  });

  it('downgrades when vision had not started (pending)', () => {
    expect(shouldDowngradeVisionOnFailure('pending')).toBe(true);
  });

  it('does NOT downgrade when vision already succeeded (failure was in per-frame edit)', () => {
    expect(shouldDowngradeVisionOnFailure('completed')).toBe(false);
  });

  it('downgrades when status is already failed (idempotent rewrite)', () => {
    expect(shouldDowngradeVisionOnFailure('failed')).toBe(true);
  });
});

describe('rejectionReasonMessage', () => {
  it('extracts message from Error instances', () => {
    expect(rejectionReasonMessage(new Error('boom'))).toBe('boom');
  });

  it('returns string rejections verbatim', () => {
    expect(rejectionReasonMessage('plain string reason')).toBe(
      'plain string reason'
    );
  });

  it('serializes plain object rejections so the original payload survives', () => {
    expect(rejectionReasonMessage({ code: 503, msg: 'svc down' })).toContain(
      '503'
    );
  });

  it('falls back to a typeof tag for non-serializable values (e.g. circular refs)', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(rejectionReasonMessage(circular)).toBe(
      'non-error rejection (object)'
    );
  });

  it('falls back for empty-object rejections rather than producing `{}`', () => {
    expect(rejectionReasonMessage({})).toBe('non-error rejection (object)');
  });
});

describe('settledToResult', () => {
  it('passes fulfilled results through unchanged', () => {
    const fulfilled: PromiseSettledResult<FrameResult> = {
      status: 'fulfilled',
      value: { frameId: 'f1', success: true, imageUrl: 'https://r2/a.png' },
    };
    expect(settledToResult(fulfilled, 'ignored')).toEqual({
      frameId: 'f1',
      success: true,
      imageUrl: 'https://r2/a.png',
    });
  });

  it('converts Error rejection to a failure result with the message', () => {
    const rejected: PromiseSettledResult<FrameResult> = {
      status: 'rejected',
      reason: new Error('invoke failed'),
    };
    expect(settledToResult(rejected, 'f1')).toEqual({
      frameId: 'f1',
      success: false,
      error: 'invoke failed',
    });
  });

  it('uses `unknown` frameId when the index lookup returns undefined', () => {
    const rejected: PromiseSettledResult<FrameResult> = {
      status: 'rejected',
      reason: new Error('boom'),
    };
    expect(settledToResult(rejected, undefined)).toEqual({
      frameId: 'unknown',
      success: false,
      error: 'boom',
    });
  });
});
