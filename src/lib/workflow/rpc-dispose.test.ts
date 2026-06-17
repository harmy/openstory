/**
 * Tests for `disposeRpcStub`, the helper that releases Cloudflare Workflow RPC
 * result stubs to stop the "An RPC result was not disposed properly" warning
 * burst (#933).
 *
 * The contract has three load-bearing guarantees, all exercised here:
 *   1. it calls `Symbol.dispose` when the stub carries one (the real path),
 *   2. it's a no-op for `null`/`undefined` and for plain objects lacking the
 *      disposer (the vitest-mock path the integration tests rely on),
 *   3. it never throws — it runs inside `finally` blocks at every call site, so
 *      a disposer throw must not override the caller's real return value/error.
 */

import { describe, expect, test, vi } from 'vitest';
import { disposeRpcStub } from './rpc-dispose';

describe('disposeRpcStub', () => {
  test('calls Symbol.dispose exactly once when present', () => {
    const dispose = vi.fn();
    disposeRpcStub({ [Symbol.dispose]: dispose });
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  test('is a no-op for null and undefined', () => {
    expect(() => disposeRpcStub(null)).not.toThrow();
    expect(() => disposeRpcStub(undefined)).not.toThrow();
  });

  test('is a no-op for a plain object without the disposer (the mock path)', () => {
    expect(() => disposeRpcStub({ id: 'abc' })).not.toThrow();
  });

  test('swallows a throwing disposer so cleanup never alters control flow', () => {
    const dispose = vi.fn(() => {
      throw new Error('double dispose');
    });
    expect(() => disposeRpcStub({ [Symbol.dispose]: dispose })).not.toThrow();
    expect(dispose).toHaveBeenCalledTimes(1);
  });
});
