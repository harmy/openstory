/**
 * Unit test for the scene timeline arithmetic used by `merge-sequence.ts`.
 * Pure math; no Mediabunny or WebCodecs surface needed.
 */

import { describe, expect, test } from 'bun:test';
import { computeSceneOffsets } from './timeline-offsets';

describe('scene timeline offsets', () => {
  test('empty list yields zero total and empty offsets', () => {
    const { offsets, total } = computeSceneOffsets([]);
    expect(offsets).toEqual([]);
    expect(total).toBe(0);
  });

  test('single scene starts at 0 and total = duration', () => {
    const { offsets, total } = computeSceneOffsets([3.5]);
    expect(offsets).toEqual([0]);
    expect(total).toBe(3.5);
  });

  test('multiple scenes accumulate without drift', () => {
    const durations = [3.0, 2.5, 4.25, 1.75];
    const { offsets, total } = computeSceneOffsets(durations);
    expect(offsets).toEqual([0, 3.0, 5.5, 9.75]);
    expect(total).toBe(11.5);
  });

  test('uneven scene durations from real motion model output', () => {
    // Approximating realistic Kling/Veo scene durations (5s ± a few frames)
    const durations = [4.96, 5.04, 5.0, 4.98];
    const { offsets, total } = computeSceneOffsets(durations);
    expect(offsets[0]).toBe(0);
    expect(offsets[1]).toBeCloseTo(4.96, 5);
    expect(offsets[2]).toBeCloseTo(10.0, 5);
    expect(offsets[3]).toBeCloseTo(15.0, 5);
    expect(total).toBeCloseTo(19.98, 5);
  });

  test('total drift across 12 scenes stays under one ms', () => {
    // Equal-duration scenes — verifies floating-point accumulation behavior.
    const durations = Array.from({ length: 12 }, () => 5.0);
    const { total } = computeSceneOffsets(durations);
    expect(Math.abs(total - 60)).toBeLessThan(1e-9);
  });
});
