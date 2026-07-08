import {
  prioritizeRecommendedStyles,
  RECOMMENDED_STYLE_SLOT_COUNT,
} from '@/lib/style/prioritize-recommended-styles';
import type { StyleRecommendation } from '@/hooks/use-styles';
import type { Style } from '@/types/database';
import { describe, expect, it } from 'vitest';

function makeStyle(id: string): Style {
  return {
    id,
    teamId: 'team-1',
    name: id,
    description: null,
    config: {
      mood: 'moody',
      artStyle: 'art',
      lighting: 'low',
      colorPalette: [],
      cameraWork: 'static',
      referenceFilms: [],
      colorGrading: 'neutral',
    },
    category: 'cinematic',
    tags: [],
    isPublic: true,
    isTemplate: false,
    version: 1,
    previewUrl: null,
    sampleVideos: [],
    recommendedImageModel: null,
    recommendedVideoModel: null,
    defaultAspectRatio: null,
    useCases: [],
    sortOrder: 0,
    usageCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: 'user-1',
  };
}

const recs: StyleRecommendation[] = [
  { styleId: 'c', score: 90, reasoning: 'fits' },
  { styleId: 'a', score: 80, reasoning: 'also fits' },
];

describe('prioritizeRecommendedStyles', () => {
  const styles = [
    makeStyle('a'),
    makeStyle('b'),
    makeStyle('c'),
    makeStyle('d'),
  ];

  it('places recommendations first in rank order', () => {
    expect(
      prioritizeRecommendedStyles(
        styles,
        recs,
        RECOMMENDED_STYLE_SLOT_COUNT
      ).map((s) => s.id)
    ).toEqual(['c', 'a', 'b', 'd']);
  });

  it('bumps a non-recommended selection to the front of the tail', () => {
    expect(
      prioritizeRecommendedStyles(styles, recs, 5, 'd').map((s) => s.id)
    ).toEqual(['c', 'a', 'd', 'b']);
  });

  it('falls back to selected-first ordering without recommendations', () => {
    expect(
      prioritizeRecommendedStyles(styles, undefined, 5, 'd').map((s) => s.id)
    ).toEqual(['d', 'a', 'b', 'c']);
  });
});
