import { describe, expect, test } from 'bun:test';
import {
  calculateImageCost,
  calculateVideoCost,
  calculateAudioCost,
} from './fal-cost';
import { micros, ZERO_MICROS, usdToMicros } from '@/lib/billing/money';

/** Helper: convert expected USD to micros for comparison */
const usd = (n: number) => usdToMicros(n);

describe('calculateImageCost', () => {
  test('per_image model (grok-imagine-image)', () => {
    const cost = calculateImageCost({
      endpointId: 'xai/grok-imagine-image',
      numImages: 2,
    });
    // 20_000 micros * 2 = 40_000
    expect(cost).toBe(micros(40_000));
  });

  test('per_megapixel model (flux-2)', () => {
    const cost = calculateImageCost({
      endpointId: 'fal-ai/flux-2',
      numImages: 1,
      widthPx: 1024,
      heightPx: 1024,
    });
    const megapixels = (1024 * 1024) / 1_000_000;
    // 12_000 micros * megapixels
    expect(cost).toBe(micros(Math.round(12_000 * megapixels)));
  });

  test('per_compute_second model (hunyuan-image instruct/edit)', () => {
    const cost = calculateImageCost({
      endpointId: 'fal-ai/hunyuan-image/v3/instruct/edit',
      numImages: 1,
    });
    // 1_670 micros * 3 (default compute seconds) = 5_010
    expect(cost).toBe(micros(5_010));
  });

  test('nano-banana-2 base resolution', () => {
    const cost = calculateImageCost({
      endpointId: 'fal-ai/nano-banana-2',
      numImages: 1,
    });
    expect(cost).toBe(micros(80_000));
  });

  test('nano-banana-2 at 4K resolution (2x multiplier)', () => {
    const cost = calculateImageCost({
      endpointId: 'fal-ai/nano-banana-2',
      numImages: 1,
      resolution: '4K',
    });
    expect(cost).toBe(micros(160_000));
  });

  test('nano-banana-2 at 0.5K resolution (0.75x multiplier)', () => {
    const cost = calculateImageCost({
      endpointId: 'fal-ai/nano-banana-2',
      numImages: 1,
      resolution: '0.5K',
    });
    expect(cost).toBe(micros(60_000));
  });

  test('nano-banana-pro at 4K (2x multiplier)', () => {
    const cost = calculateImageCost({
      endpointId: 'fal-ai/nano-banana-pro',
      numImages: 1,
      resolution: '4K',
    });
    expect(cost).toBe(micros(300_000));
  });

  test('unknown endpoint returns 0', () => {
    const cost = calculateImageCost({
      endpointId: 'unknown/model',
      numImages: 1,
    });
    expect(cost).toBe(ZERO_MICROS);
  });
});

describe('calculateVideoCost', () => {
  test('Veo3.1 audio on at 1080p ($0.40/s)', () => {
    const cost = calculateVideoCost({
      endpointId: 'fal-ai/veo3.1/image-to-video',
      durationSeconds: 8,
      audioEnabled: true,
      resolution: '1080p',
    });
    // 400_000 * 8 = 3_200_000
    expect(cost).toBe(usd(3.2));
  });

  test('Veo3.1 audio off at 1080p ($0.20/s)', () => {
    const cost = calculateVideoCost({
      endpointId: 'fal-ai/veo3.1/image-to-video',
      durationSeconds: 8,
      audioEnabled: false,
      resolution: '1080p',
    });
    // 200_000 * 8 = 1_600_000
    expect(cost).toBe(usd(1.6));
  });

  test('Veo3.1 at 1080p with audio ($0.40/s)', () => {
    const cost = calculateVideoCost({
      endpointId: 'fal-ai/veo3.1/image-to-video',
      durationSeconds: 8,
      audioEnabled: true,
      resolution: '1080p',
    });
    expect(cost).toBe(usd(3.2));
  });

  test('Veo3.1 at 4K with audio ($0.60/s)', () => {
    const cost = calculateVideoCost({
      endpointId: 'fal-ai/veo3.1/image-to-video',
      durationSeconds: 8,
      audioEnabled: true,
      resolution: '4K',
    });
    expect(cost).toBe(usd(4.8));
  });

  test('Veo3.1 at 4K no audio ($0.40/s)', () => {
    const cost = calculateVideoCost({
      endpointId: 'fal-ai/veo3.1/image-to-video',
      durationSeconds: 8,
      audioEnabled: false,
      resolution: '4K',
    });
    expect(cost).toBe(usd(3.2));
  });

  test('Veo3.1 at 1080p no audio ($0.20/s)', () => {
    const cost = calculateVideoCost({
      endpointId: 'fal-ai/veo3.1/image-to-video',
      durationSeconds: 8,
      audioEnabled: false,
      resolution: '1080p',
    });
    expect(cost).toBe(usd(1.6));
  });

  test('Kling v3 Pro audio off (0.8x multiplier)', () => {
    const cost = calculateVideoCost({
      endpointId: 'fal-ai/kling-video/v3/pro/image-to-video',
      durationSeconds: 5,
      audioEnabled: false,
    });
    // 140_000 * 0.8 = 112_000 per second, * 5 = 560_000
    expect(cost).toBe(micros(560_000));
  });

  test('Kling v3 Pro audio on (1.2x multiplier)', () => {
    const cost = calculateVideoCost({
      endpointId: 'fal-ai/kling-video/v3/pro/image-to-video',
      durationSeconds: 5,
      audioEnabled: true,
    });
    // 140_000 * 1.2 = 168_000 per second, * 5 = 840_000
    expect(cost).toBe(micros(840_000));
  });

  test('Kling v3 Pro voice control (1.4x multiplier)', () => {
    const cost = calculateVideoCost({
      endpointId: 'fal-ai/kling-video/v3/pro/image-to-video',
      durationSeconds: 5,
      audioEnabled: true,
      voiceControl: true,
    });
    // 140_000 * 1.4 = 196_000 per second, * 5 = 980_000
    expect(cost).toBe(micros(980_000));
  });

  test('LTX 2.3 simple per_second pricing ($0.06/s)', () => {
    const cost = calculateVideoCost({
      endpointId: 'fal-ai/ltx-2.3/image-to-video',
      durationSeconds: 5,
    });
    // 60_000 * 5 = 300_000
    expect(cost).toBe(micros(300_000));
  });

  test('Minimax Hailuo-02 Pro simple per_second pricing ($0.08/s)', () => {
    const cost = calculateVideoCost({
      endpointId: 'fal-ai/minimax/hailuo-02/pro/image-to-video',
      durationSeconds: 5,
    });
    // 80_000 * 5 = 400_000
    expect(cost).toBe(micros(400_000));
  });

  test('Grok Video 480p ($0.05/s + $0.002)', () => {
    const cost = calculateVideoCost({
      endpointId: 'xai/grok-imagine-video/image-to-video',
      durationSeconds: 6,
      resolution: '480p',
    });
    // 50_000 * 6 + 2_000 = 302_000
    expect(cost).toBe(micros(302_000));
  });

  test('Grok Video 720p ($0.07/s + $0.002)', () => {
    const cost = calculateVideoCost({
      endpointId: 'xai/grok-imagine-video/image-to-video',
      durationSeconds: 6,
      resolution: '720p',
    });
    // 70_000 * 6 + 2_000 = 422_000
    expect(cost).toBe(micros(422_000));
  });

  test('Seedance v1.5 Pro 5s ($1.2/s)', () => {
    const cost = calculateVideoCost({
      endpointId: 'fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
      durationSeconds: 5,
    });
    // 1_200_000 * 5 = 6_000_000
    expect(cost).toBe(micros(6_000_000));
  });

  test('Seedance v1.5 Pro 10s ($1.2/s)', () => {
    const cost = calculateVideoCost({
      endpointId: 'fal-ai/bytedance/seedance/v1.5/pro/image-to-video',
      durationSeconds: 10,
    });
    // 1_200_000 * 10 = 12_000_000
    expect(cost).toBe(micros(12_000_000));
  });

  test('unknown endpoint returns 0', () => {
    const cost = calculateVideoCost({
      endpointId: 'unknown/model',
      durationSeconds: 5,
    });
    expect(cost).toBe(ZERO_MICROS);
  });
});

describe('calculateAudioCost', () => {
  test('ElevenLabs Music 30s (rounds to 1 min)', () => {
    const cost = calculateAudioCost({
      endpointId: 'fal-ai/elevenlabs/music',
      durationSeconds: 30,
    });
    expect(cost).toBe(usd(0.8));
  });

  test('ElevenLabs Music 60s (exactly 1 min)', () => {
    const cost = calculateAudioCost({
      endpointId: 'fal-ai/elevenlabs/music',
      durationSeconds: 60,
    });
    expect(cost).toBe(usd(0.8));
  });

  test('ElevenLabs Music 61s (rounds to 2 min)', () => {
    const cost = calculateAudioCost({
      endpointId: 'fal-ai/elevenlabs/music',
      durationSeconds: 61,
    });
    expect(cost).toBe(usd(1.6));
  });

  test('ACE-Step per_second pricing', () => {
    const cost = calculateAudioCost({
      endpointId: 'fal-ai/ace-step/prompt-to-audio',
      durationSeconds: 60,
    });
    // 200 micros * 60 = 12_000
    expect(cost).toBe(micros(12_000));
  });

  test('ElevenLabs SFX per_second pricing', () => {
    const cost = calculateAudioCost({
      endpointId: 'fal-ai/elevenlabs/sound-effects',
      durationSeconds: 5,
    });
    // 2_000 * 5 = 10_000
    expect(cost).toBe(micros(10_000));
  });

  test('MMAudio per_second pricing', () => {
    const cost = calculateAudioCost({
      endpointId: 'fal-ai/mmaudio-v2',
      durationSeconds: 8,
    });
    // 1_000 * 8 = 8_000
    expect(cost).toBe(micros(8_000));
  });

  test('Lyria2 per_second pricing', () => {
    const cost = calculateAudioCost({
      endpointId: 'fal-ai/lyria2',
      durationSeconds: 10,
    });
    // 100_000 * 10 = 1_000_000
    expect(cost).toBe(micros(1_000_000));
  });

  test('unknown endpoint returns 0', () => {
    const cost = calculateAudioCost({
      endpointId: 'unknown/model',
      durationSeconds: 60,
    });
    expect(cost).toBe(ZERO_MICROS);
  });
});
