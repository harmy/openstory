import { describe, expect, it } from 'vitest';
import {
  resolveSceneImageModel,
  resolveSceneVideoModel,
} from './resolve-scene-models';

const sequence = { imageModel: 'flux_2_max', videoModel: 'kling_v3_pro' };

describe('resolveSceneImageModel', () => {
  it('prefers the scene override when set', () => {
    expect(
      resolveSceneImageModel({ imageModel: 'gpt_image_2' }, sequence)
    ).toBe('gpt_image_2');
  });

  it('falls back to the sequence default when the scene inherits (null)', () => {
    expect(resolveSceneImageModel({ imageModel: null }, sequence)).toBe(
      'flux_2_max'
    );
    expect(resolveSceneImageModel(null, sequence)).toBe('flux_2_max');
  });

  it('inherits the sequence default when the scene override is set but invalid', () => {
    // e.g. a model id retired after the scene saved it — the user's sequence
    // choice must win over the global app default.
    expect(
      resolveSceneImageModel({ imageModel: 'retired_model' }, sequence)
    ).toBe('flux_2_max');
  });

  it('falls back to the app default when both are invalid/empty', () => {
    expect(
      resolveSceneImageModel(
        { imageModel: 'not_a_model' },
        {
          imageModel: '',
          videoModel: '',
        }
      )
    ).toBe('gpt_image_2');
  });
});

describe('resolveSceneVideoModel', () => {
  it('prefers the scene override when set', () => {
    expect(
      resolveSceneVideoModel({ videoModel: 'seedance_v2' }, sequence)
    ).toBe('seedance_v2');
  });

  it('falls back to the sequence default when the scene inherits (null)', () => {
    expect(resolveSceneVideoModel({ videoModel: null }, sequence)).toBe(
      'kling_v3_pro'
    );
    expect(resolveSceneVideoModel(undefined, sequence)).toBe('kling_v3_pro');
  });

  it('inherits the sequence default when the scene override is set but invalid', () => {
    expect(
      resolveSceneVideoModel({ videoModel: 'retired_model' }, sequence)
    ).toBe('kling_v3_pro');
  });

  it('falls back to the app default when both are invalid/empty', () => {
    expect(
      resolveSceneVideoModel(
        { videoModel: 'bogus' },
        {
          imageModel: '',
          videoModel: '',
        }
      )
    ).toBe('seedance_v2');
  });
});
