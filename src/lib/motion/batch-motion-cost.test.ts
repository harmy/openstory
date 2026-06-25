import { describe, expect, it } from 'vitest';
import {
  estimateBatchMotionCost,
  resolveBatchShotVideoModel,
} from './batch-motion-cost';
import { estimateVideoCost } from '@/lib/billing/cost-estimation';
import { addMicros, ZERO_MICROS } from '@/lib/billing/money';
import { snapDuration } from '@/lib/motion/motion-generation';

const sequence = { videoModel: 'minimax_hailuo_02' };
const sceneA = { videoModel: 'seedance_v2' };
const sceneB = { videoModel: 'kling_v3_pro' };
const scenesById = new Map([
  ['scene-a', sceneA],
  ['scene-b', sceneB],
]);

describe('resolveBatchShotVideoModel', () => {
  it('prefers the explicit batch model over scene and sequence', () => {
    expect(
      resolveBatchShotVideoModel(
        { sceneId: 'scene-a' },
        scenesById,
        sequence,
        'kling_v3_pro'
      )
    ).toBe('kling_v3_pro');
  });

  it("resolves the shot's parent scene model when no explicit model", () => {
    expect(
      resolveBatchShotVideoModel({ sceneId: 'scene-a' }, scenesById, sequence)
    ).toBe('seedance_v2');
  });

  it('falls back to the sequence default when the shot has no scene', () => {
    expect(
      resolveBatchShotVideoModel({ sceneId: null }, scenesById, sequence)
    ).toBe('minimax_hailuo_02');
  });

  it('falls back to the sequence default when the sceneId is unknown', () => {
    expect(
      resolveBatchShotVideoModel(
        { sceneId: 'scene-missing' },
        scenesById,
        sequence
      )
    ).toBe('minimax_hailuo_02');
  });
});

describe('estimateBatchMotionCost', () => {
  it('sums per-shot cost across scenes using different (priced) models', () => {
    const shots = [{ sceneId: 'scene-a' }, { sceneId: 'scene-b' }];
    const expected = addMicros(
      addMicros(
        ZERO_MICROS,
        estimateVideoCost('seedance_v2', snapDuration(undefined, 'seedance_v2'))
      ),
      estimateVideoCost('kling_v3_pro', snapDuration(undefined, 'kling_v3_pro'))
    );
    expect(estimateBatchMotionCost(shots, scenesById, sequence)).toEqual(
      expected
    );
  });

  it('prices every shot with the explicit batch model when given', () => {
    const shots = [{ sceneId: 'scene-a' }, { sceneId: 'scene-b' }];
    const perShot = estimateVideoCost(
      'kling_v3_pro',
      snapDuration(5, 'kling_v3_pro')
    );
    const expected = addMicros(addMicros(ZERO_MICROS, perShot), perShot);
    expect(
      estimateBatchMotionCost(shots, scenesById, sequence, {
        explicitModel: 'kling_v3_pro',
        duration: 5,
      })
    ).toEqual(expected);
  });

  it('is ZERO for an empty shot list', () => {
    expect(estimateBatchMotionCost([], scenesById, sequence)).toEqual(
      ZERO_MICROS
    );
  });
});
