import { describe, expect, it } from 'vitest';
import { createStyleSchema, updateStyleSchema } from './style.schemas';

const baseConfig = {
  mood: 'neutral',
  artStyle: 'cinematic',
  lighting: 'natural',
  colorPalette: ['#000', '#fff'],
  cameraWork: 'static',
  referenceFilms: [],
  colorGrading: 'neutral',
};

describe('style schemas', () => {
  it('strips client-provided public/template flags when creating a style', () => {
    const parsed = createStyleSchema.parse({
      name: 'Team Style',
      config: baseConfig,
      isPublic: true,
      isTemplate: true,
      teamId: 'other-team',
      createdBy: 'other-user',
      usageCount: 99,
      sortOrder: 1,
    });

    expect(parsed).toMatchObject({
      name: 'Team Style',
      config: baseConfig,
    });
    expect(parsed).not.toHaveProperty('isPublic');
    expect(parsed).not.toHaveProperty('isTemplate');
    expect(parsed).not.toHaveProperty('teamId');
    expect(parsed).not.toHaveProperty('createdBy');
    expect(parsed).not.toHaveProperty('usageCount');
    expect(parsed).not.toHaveProperty('sortOrder');
  });

  it('strips client-provided public/template flags when updating a style', () => {
    const parsed = updateStyleSchema.parse({
      name: 'Updated Style',
      isPublic: true,
      isTemplate: true,
      teamId: 'other-team',
      createdBy: 'other-user',
      usageCount: 99,
      sortOrder: 1,
    });

    expect(parsed).toEqual({ name: 'Updated Style' });
  });
});
