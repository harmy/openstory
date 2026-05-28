import type { Style } from '@/types/database';
import { describe, expect, test } from 'vitest';
import { filterStyles } from './style-filters';

import { MOCK_SYSTEM_STYLES } from '../style/style-templates';
// Use MOCK_SYSTEM_STYLES which includes id and teamId
const mockStyles = MOCK_SYSTEM_STYLES;

describe('filterStyles', () => {
  describe('category filtering', () => {
    test('returns all styles when category is "all"', () => {
      const result = filterStyles(mockStyles, 'all', '');
      expect(result).toEqual(mockStyles);
      expect(result.length).toBe(15);
    });

    test('filters by specific category', () => {
      const result = filterStyles(mockStyles, 'cinematic', '');
      expect(result.length).toBe(1);
      const [first] = result;
      if (!first) throw new Error('test setup: expected one result');
      expect(first.name).toBe('Award Season');
    });

    test('filters by "new" category (last 7 days)', () => {
      const result = filterStyles(mockStyles, 'new', '');
      // All styles are created at the same time, so all should be new
      expect(result.length).toBe(15);
    });

    test('returns empty array for non-matching category', () => {
      const result = filterStyles(mockStyles, 'vintage', '');
      expect(result.length).toBe(0);
    });
  });

  describe('search query filtering', () => {
    test('returns all styles when search query is empty', () => {
      const result = filterStyles(mockStyles, 'all', '');
      expect(result.length).toBe(15);
    });

    test('returns all styles when search query is whitespace', () => {
      const result = filterStyles(mockStyles, 'all', '   ');
      expect(result.length).toBe(15);
    });

    test('filters by name match (case insensitive)', () => {
      const result = filterStyles(mockStyles, 'all', 'cinematic');
      expect(result.length).toBe(2);
      expect(result.map((s) => s.name)).toContain('Award Season');
      expect(result.map((s) => s.name)).toContain('Animated');
    });

    test('filters by description match', () => {
      const result = filterStyles(mockStyles, 'all', 'bright');
      expect(result.length).toBe(1);
      const [first] = result;
      if (!first) throw new Error('test setup: expected one result');
      expect(first.name).toBe('Rom-Com');
    });

    test('filters by category match in search', () => {
      const result = filterStyles(mockStyles, 'all', 'documentary');
      expect(result.length).toBe(1);
      const [first] = result;
      if (!first) throw new Error('test setup: expected one result');
      expect(first.name).toBe('Documentary');
    });

    test('filters by tag match', () => {
      const result = filterStyles(mockStyles, 'all', 'emotional');
      expect(result.length).toBe(1);
      const [first] = result;
      if (!first) throw new Error('test setup: expected one result');
      expect(first.name).toBe('Award Season');
    });

    test('returns multiple matches for common search term', () => {
      const result = filterStyles(mockStyles, 'all', 'lighting');
      // Multiple descriptions contain "lighting"
      expect(result.length).toBeGreaterThan(1);
    });

    test('handles partial matches', () => {
      const result = filterStyles(mockStyles, 'all', 'anim');
      expect(result.length).toBe(2);
      expect(result.map((s) => s.name)).toContain('Animated');
      expect(result.map((s) => s.name)).toContain('Animatic');
    });

    test('returns empty array for non-matching search', () => {
      const result = filterStyles(mockStyles, 'all', 'nonexistent');
      expect(result.length).toBe(0);
    });
  });

  describe('combined category and search filtering', () => {
    test('applies both category and search filters', () => {
      const result = filterStyles(mockStyles, 'ecommerce', 'product');
      expect(result.length).toBe(1);
      const [first] = result;
      if (!first) throw new Error('test setup: expected one result');
      expect(first.name).toBe('Product Ad');
    });

    test('returns empty when category matches but search does not', () => {
      const result = filterStyles(mockStyles, 'cinematic', 'nonexistent');
      expect(result.length).toBe(0);
    });

    test('returns empty when search matches but category does not', () => {
      const result = filterStyles(mockStyles, 'vintage', 'cinematic');
      expect(result.length).toBe(0);
    });

    test('filters new items with search query', () => {
      const result = filterStyles(mockStyles, 'new', 'animation');
      expect(result.length).toBe(2);
      expect(result.map((s) => s.name)).toContain('Animated');
      expect(result.map((s) => s.name)).toContain('Animatic');
    });
  });

  describe('edge cases', () => {
    const [baseStyle] = mockStyles;
    if (!baseStyle) {
      throw new Error('test setup: MOCK_SYSTEM_STYLES is empty');
    }

    test('handles empty styles array', () => {
      const result = filterStyles([], 'all', '');
      expect(result.length).toBe(0);
    });

    test('handles null/undefined description', () => {
      const stylesWithNullDesc: Style[] = [
        {
          ...baseStyle,
          description: null,
        },
      ];
      const result = filterStyles(stylesWithNullDesc, 'all', 'test');
      expect(result.length).toBe(0);
    });

    test('handles null/undefined category', () => {
      const stylesWithNullCategory: Style[] = [
        {
          ...baseStyle,
          category: null,
        },
      ];
      const result = filterStyles(stylesWithNullCategory, 'cinematic', '');
      expect(result.length).toBe(0);
    });

    test('handles empty tags array', () => {
      const stylesWithEmptyTags: Style[] = [
        {
          ...baseStyle,
          name: 'Test Style',
          description: 'A test style',
          category: 'test',
          tags: [],
        },
      ];
      const result = filterStyles(stylesWithEmptyTags, 'all', 'moody');
      expect(result.length).toBe(0);
    });

    test('handles null tags array', () => {
      const stylesWithNullTags: Style[] = [
        {
          ...baseStyle,
          name: 'Test Style',
          description: 'A test style',
          category: 'test',
          tags: null,
        },
      ];
      const result = filterStyles(stylesWithNullTags, 'all', 'moody');
      expect(result.length).toBe(0);
    });
  });
});
