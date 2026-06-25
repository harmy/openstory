/**
 * Tests for the pure logic behind `updateSceneModelFn` (#909). The full
 * server-fn middleware chain (auth, sequence access, scoped DB) is covered by
 * e2e; here we exercise the caller-supplied-id ownership guard, the patch
 * builder's inherit/clear semantics, and the model-validation schema so a
 * regression (cross-sequence write, dropped guard, unknown model) fails fast.
 */

import { describe, expect, it } from 'vitest';
import {
  assertSceneOwnedBySequence,
  buildSceneModelPatch,
  sceneModelSchema,
} from '@/functions/scenes';

describe('assertSceneOwnedBySequence', () => {
  it('passes for a scene that belongs to the sequence', () => {
    expect(() =>
      assertSceneOwnedBySequence({ sequenceId: 'seq-1' }, 'seq-1')
    ).not.toThrow();
  });

  it('throws when the scene is missing', () => {
    expect(() => assertSceneOwnedBySequence(null, 'seq-1')).toThrow(
      /not found for this sequence/
    );
  });

  it('throws when the scene belongs to a different sequence', () => {
    expect(() =>
      assertSceneOwnedBySequence({ sequenceId: 'seq-other' }, 'seq-1')
    ).toThrow(/not found for this sequence/);
  });
});

describe('buildSceneModelPatch', () => {
  const base = { sequenceId: 'seq-1', sceneId: 'scene-1' };

  it('writes only the fields that are present', () => {
    expect(
      buildSceneModelPatch({ ...base, imageModel: 'gpt_image_2' })
    ).toEqual({ imageModel: 'gpt_image_2' });
  });

  it('coerces an explicit null to clearing the override (inherit)', () => {
    expect(buildSceneModelPatch({ ...base, videoModel: null })).toEqual({
      videoModel: null,
    });
  });

  it('leaves both untouched when neither is provided', () => {
    expect(buildSceneModelPatch(base)).toEqual({});
  });

  it('can set both at once', () => {
    expect(
      buildSceneModelPatch({
        ...base,
        imageModel: 'gpt_image_2',
        videoModel: 'seedance_v2',
      })
    ).toEqual({ imageModel: 'gpt_image_2', videoModel: 'seedance_v2' });
  });
});

describe('sceneModelSchema', () => {
  const base = {
    sequenceId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
    sceneId: '01ARZ3NDEKTSV4RRFFQ69G5FAW',
  };

  it('accepts a known image model and null video (inherit)', () => {
    const parsed = sceneModelSchema.safeParse({
      ...base,
      imageModel: 'gpt_image_2',
      videoModel: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects an unknown image model', () => {
    const parsed = sceneModelSchema.safeParse({
      ...base,
      imageModel: 'not_a_model',
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown video model', () => {
    const parsed = sceneModelSchema.safeParse({
      ...base,
      videoModel: 'not_a_model',
    });
    expect(parsed.success).toBe(false);
  });
});
