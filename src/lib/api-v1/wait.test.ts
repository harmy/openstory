import { describe, expect, it } from 'vitest';
import { longPoll, parseWaitParam } from './wait';

describe('parseWaitParam', () => {
  it('parses bare seconds, suffixed units, and ms', () => {
    expect(parseWaitParam('30')).toBe(30_000);
    expect(parseWaitParam('45s')).toBe(45_000);
    expect(parseWaitParam('2m')).toBe(90_000); // 120s clamped to 90s cap
    expect(parseWaitParam('1m')).toBe(60_000);
    expect(parseWaitParam('1500ms')).toBe(1_500);
  });

  it('clamps to the 90s cap and treats absent/0 as 0', () => {
    expect(parseWaitParam('600s')).toBe(90_000);
    expect(parseWaitParam('0')).toBe(0);
    expect(parseWaitParam('')).toBe(0);
    expect(parseWaitParam('   ')).toBe(0);
    expect(parseWaitParam(null)).toBe(0);
    expect(parseWaitParam(undefined)).toBe(0);
  });

  it('returns null for a present-but-malformed value (caller 400s)', () => {
    expect(parseWaitParam('soon')).toBeNull();
    expect(parseWaitParam('-5')).toBeNull();
    expect(parseWaitParam('30x')).toBeNull();
    expect(parseWaitParam('1.5s')).toBeNull();
  });
});

describe('longPoll', () => {
  // A fake clock + sleep so tests run instantly: each sleep advances `clock`.
  function fakeTimers() {
    let clock = 0;
    return {
      now: () => clock,
      sleepFn: async (ms: number) => {
        clock += ms;
      },
    };
  }

  it('returns immediately when waitMs is 0 (plain GET)', async () => {
    let loads = 0;
    const res = await longPoll({
      waitMs: 0,
      load: async () => ++loads,
      cursor: (v) => String(v),
      done: () => false,
      ...fakeTimers(),
    });
    expect(res.value).toBe(1);
    expect(loads).toBe(1);
    expect(res.changed).toBe(false);
  });

  it('returns immediately when the first read is already terminal', async () => {
    const res = await longPoll({
      waitMs: 60_000,
      load: async () => 'completed',
      cursor: (v) => v,
      done: (v) => v === 'completed',
      ...fakeTimers(),
    });
    expect(res.done).toBe(true);
    expect(res.changed).toBe(false);
  });

  it('blocks until the cursor changes, then returns the new value', async () => {
    let tick = 0;
    const res = await longPoll({
      waitMs: 60_000,
      pollIntervalMs: 2_000,
      // Stays "pending" for two polls, then advances.
      load: async () => (tick++ < 2 ? 'pending' : 'pending-2'),
      cursor: (v) => v,
      done: () => false,
      ...fakeTimers(),
    });
    expect(res.value).toBe('pending-2');
    expect(res.changed).toBe(true);
  });

  it('returns the unchanged value when the deadline passes', async () => {
    let loads = 0;
    const res = await longPoll({
      waitMs: 6_000,
      pollIntervalMs: 2_000,
      load: async () => {
        loads++;
        return 'pending';
      },
      cursor: (v) => v,
      done: () => false,
      ...fakeTimers(),
    });
    expect(res.changed).toBe(false);
    expect(res.value).toBe('pending');
    // 1 initial + 3 polls (at 2s, 4s, 6s) before the 6s deadline is reached.
    expect(loads).toBe(4);
  });

  it('stops early when the signal aborts', async () => {
    const controller = new AbortController();
    let loads = 0;
    const res = await longPoll({
      waitMs: 60_000,
      pollIntervalMs: 2_000,
      load: async () => {
        loads++;
        if (loads === 2) controller.abort();
        return 'pending';
      },
      cursor: (v) => v,
      done: () => false,
      signal: controller.signal,
      ...fakeTimers(),
    });
    expect(res.changed).toBe(false);
    expect(loads).toBeLessThan(4);
  });
});
