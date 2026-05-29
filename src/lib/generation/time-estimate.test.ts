import { describe, expect, test } from 'vitest';
import {
  estimateRemainingSeconds,
  estimateSceneCount,
  estimateTotalSeconds,
  formatTimeRemaining,
} from './time-estimate';

describe('estimateSceneCount', () => {
  test('short script estimates 1 scene', () => {
    const script = 'A man walks into a bar and orders a drink.';
    expect(estimateSceneCount(script)).toBe(1);
  });

  test('medium script estimates proportionally', () => {
    // ~240 words → ~2 scenes
    const script = Array(240).fill('word').join(' ');
    expect(estimateSceneCount(script)).toBe(2);
  });

  test('long script clamps to 30', () => {
    const script = Array(5000).fill('word').join(' ');
    expect(estimateSceneCount(script)).toBe(30);
  });

  test('empty script returns 1', () => {
    expect(estimateSceneCount('')).toBe(1);
  });
});

describe('estimateTotalSeconds', () => {
  test('returns reasonable total for any scene count', () => {
    const total = estimateTotalSeconds(6);
    // All 5 phases (including optional motion/music), ~7-8min
    expect(total).toBeGreaterThan(300);
    expect(total).toBeLessThan(600);
  });

  test('uses default scene count for 0', () => {
    expect(estimateTotalSeconds(0)).toBe(estimateTotalSeconds(6));
  });

  test('uses estimatedSceneCount as fallback when sceneCount is 0', () => {
    expect(estimateTotalSeconds(0, 10)).toBe(estimateTotalSeconds(10));
  });

  test('ignores estimatedSceneCount when sceneCount > 0', () => {
    expect(estimateTotalSeconds(5, 10)).toBe(estimateTotalSeconds(5));
  });
});

describe('estimateRemainingSeconds', () => {
  test('decreases as phases complete', () => {
    const full = estimateRemainingSeconds({
      sceneCount: 6,
      completedPhases: [],
      elapsedSeconds: 0,
    });

    const partial = estimateRemainingSeconds({
      sceneCount: 6,
      completedPhases: [1, 2, 3],
      elapsedSeconds: 30,
    });

    expect(partial).toBeLessThan(full);
  });

  test('never returns negative', () => {
    const result = estimateRemainingSeconds({
      sceneCount: 6,
      completedPhases: [1, 2, 3, 4, 5],
      elapsedSeconds: 9999,
    });

    expect(result).toBe(0);
  });

  test('returns 0 when all phases completed', () => {
    const result = estimateRemainingSeconds({
      sceneCount: 1,
      completedPhases: [1, 2, 3, 4, 5],
      elapsedSeconds: 0,
    });

    expect(result).toBe(0);
  });
});

describe('formatTimeRemaining', () => {
  test('shows "Finishing up…" at 0', () => {
    expect(formatTimeRemaining(0)).toBe('Finishing up\u2026');
  });

  test('shows seconds for < 60', () => {
    expect(formatTimeRemaining(30)).toBe('30s remaining');
  });

  test('shows minutes:seconds for 60', () => {
    expect(formatTimeRemaining(60)).toBe('1:00 remaining');
  });

  test('shows minutes:seconds for 150', () => {
    expect(formatTimeRemaining(150)).toBe('2:30 remaining');
  });
});
