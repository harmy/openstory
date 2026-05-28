import { describe, expect, test } from 'vitest';
import { buildWorkflowLabel } from './labels';

describe('buildWorkflowLabel', () => {
  test('returns the id as-is', () => {
    expect(buildWorkflowLabel('01ABCDEF12345678')).toBe('01ABCDEF12345678');
  });

  test('returns undefined for empty string', () => {
    expect(buildWorkflowLabel('')).toBeUndefined();
  });

  test('returns undefined for undefined', () => {
    expect(buildWorkflowLabel(undefined)).toBeUndefined();
  });
});
