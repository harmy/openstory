/**
 * Tests for the transient-error classifiers added for issue #839 (June 6
 * mass-abort cascade). Message strings mirror what Cloudflare emitted in
 * production logs — the thrown values' classes aren't part of CF's public
 * API, so matching is message-based and these fixtures are the contract.
 */

import { describe, expect, test } from 'vitest';
import { isEngineAbortError, isRecipientInFiniteStateError } from './errors';

describe('isEngineAbortError', () => {
  test('matches the exact prod engine-abort message', () => {
    expect(
      isEngineAbortError(new Error('Aborting engine: Grace period complete'))
    ).toBe(true);
  });

  test('matches when wrapped in a child-failure message', () => {
    expect(
      isEngineAbortError(
        new Error(
          'Child workflow analyze-script:01SEQ failed: Aborting engine: Grace period complete'
        )
      )
    ).toBe(true);
  });

  test('matches plain strings', () => {
    expect(isEngineAbortError('Aborting engine: Grace period complete')).toBe(
      true
    );
  });

  test('does not match ordinary failures', () => {
    expect(isEngineAbortError(new Error('fal request failed: 500'))).toBe(
      false
    );
    expect(
      isEngineAbortError(
        new Error('WorkflowTimeoutError: Execution timed out after 1800000ms')
      )
    ).toBe(false);
    expect(isEngineAbortError(null)).toBe(false);
    expect(isEngineAbortError(undefined)).toBe(false);
    expect(isEngineAbortError(42)).toBe(false);
  });
});

describe('isRecipientInFiniteStateError', () => {
  test('matches the exact prod in_finite_state message', () => {
    expect(
      isRecipientInFiniteStateError(
        new Error(
          '(instance.in_finite_state) Instance reached a finite state, cannot send events to it'
        )
      )
    ).toBe(true);
  });

  test('matches the NonRetryableError re-wrap (message preserved)', () => {
    // await-child's sendEventFailFast re-throws with the original message.
    expect(
      isRecipientInFiniteStateError(
        new Error('Instance reached a finite state, cannot send events to it')
      )
    ).toBe(true);
  });

  test('does not match ordinary failures', () => {
    expect(isRecipientInFiniteStateError(new Error('network down'))).toBe(
      false
    );
    expect(
      isRecipientInFiniteStateError(
        new Error('Aborting engine: Grace period complete')
      )
    ).toBe(false);
    expect(isRecipientInFiniteStateError(null)).toBe(false);
  });
});
