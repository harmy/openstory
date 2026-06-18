import { describe, expect, test } from 'vitest';
import { estimateFalCost, falCostFromUnits } from './fal-cost';
import { micros, usdToMicros, ZERO_MICROS } from '@/lib/billing/money';

const usd = (n: number) => usdToMicros(n);

describe('falCostFromUnits', () => {
  test('per-image: unitsBilled * unitPrice (resolution premium is in the count)', () => {
    // nano-banana-2 = $0.08/image. A 2K image fal bills as 1.5 units.
    expect(falCostFromUnits('fal-ai/nano-banana-2', 1)).toBe(micros(80_000));
    expect(falCostFromUnits('fal-ai/nano-banana-2', 1.5)).toBe(micros(120_000));
  });

  test('per-megapixel: fractional units', () => {
    // flux-2-max = $0.07/megapixel.
    expect(falCostFromUnits('fal-ai/flux-2-max', 1.05)).toBe(micros(73_500));
  });

  test('flat: hailuo bills 1 unit at $0.49', () => {
    expect(
      falCostFromUnits('fal-ai/minimax/hailuo-2.3/pro/image-to-video', 1)
    ).toBe(usd(0.49));
  });

  test('per-token: seedance bills 1000-token units at $0.014', () => {
    expect(
      falCostFromUnits(
        'bytedance/seedance-2.0/enterprise/v2/image-to-video',
        108
      )
    ).toBe(micros(1_512_000));
  });

  test('audio per-minute: elevenlabs bills 1 unit at $0.80', () => {
    expect(falCostFromUnits('fal-ai/elevenlabs/music', 1)).toBe(usd(0.8));
  });

  test('missing unitsBilled charges nothing', () => {
    expect(falCostFromUnits('fal-ai/nano-banana-2', undefined)).toBe(
      ZERO_MICROS
    );
  });

  test('unknown endpoint charges nothing', () => {
    expect(falCostFromUnits('unknown/model', 5)).toBe(ZERO_MICROS);
  });
});

describe('estimateFalCost', () => {
  test('per-image scales by numImages', () => {
    expect(estimateFalCost('fal-ai/nano-banana-2', { numImages: 2 })).toBe(
      micros(160_000)
    );
  });

  test('per-second scales by duration', () => {
    expect(
      estimateFalCost('fal-ai/veo3.1/image-to-video', { durationSeconds: 8 })
    ).toBe(usd(3.2));
  });

  test('per-minute rounds up', () => {
    expect(
      estimateFalCost('fal-ai/elevenlabs/music', { durationSeconds: 61 })
    ).toBe(usd(1.6));
  });

  test('compute-seconds uses a fixed estimate', () => {
    // grok-imagine-image = $0.00017/compute-second, 3s default * 2 images.
    expect(
      estimateFalCost('xai/grok-imagine-image/quality/text-to-image', {
        numImages: 2,
      })
    ).toBe(micros(1_020));
  });

  test('tokens estimate from resolution', () => {
    expect(
      estimateFalCost('bytedance/seedance-2.0/enterprise/v2/image-to-video', {
        durationSeconds: 5,
        resolution: '720p',
      })
    ).toBe(micros(1_587_600));
  });

  test('unknown endpoint estimates nothing', () => {
    expect(estimateFalCost('unknown/model', { numImages: 1 })).toBe(
      ZERO_MICROS
    );
  });
});
