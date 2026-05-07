// AUTO-GENERATED — do not edit manually. Run: bun scripts/update-fal-pricing.ts
// Manual overrides (multipliers, matrices) are maintained in scripts/update-fal-pricing.ts

import { type Microdollars, micros } from '@/lib/billing/money';

// ============================================================================
// Image Pricing (all prices in microdollars: 1 USD = 1,000,000)
// ============================================================================

type ImagePricingUnit = 'per_image' | 'per_megapixel' | 'per_compute_second';

export type ImagePricing = {
  basePrice: Microdollars;
  unit: ImagePricingUnit;
  resolutionMultipliers?: Partial<Record<'0.5K' | '1K' | '2K' | '4K', number>>;
  styleMultipliers?: Record<string, number>;
  qualitySizeMatrix?: Record<string, Record<string, Microdollars>>;
  surcharges?: { webSearch?: Microdollars };
  pricingNotes?: string;
};

export const IMAGE_PRICING: Record<string, ImagePricing> = {
  'fal-ai/bytedance/seedream/v5/lite/edit': {
    basePrice: micros(35_000),
    unit: 'per_image',
  },
  'fal-ai/bytedance/seedream/v5/lite/text-to-image': {
    basePrice: micros(35_000),
    unit: 'per_image',
  },
  'fal-ai/flux-2': {
    basePrice: micros(12_000),
    unit: 'per_megapixel',
    pricingNotes:
      '- **Price**: $0.012 per megapixels\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
  },
  'fal-ai/flux-2-max': {
    basePrice: micros(70_000),
    unit: 'per_megapixel',
  },
  'fal-ai/flux-2-max/edit': {
    basePrice: micros(70_000),
    unit: 'per_image',
  },
  'fal-ai/flux-2/edit': {
    basePrice: micros(12_000),
    unit: 'per_image',
  },
  'fal-ai/flux-2/turbo': {
    basePrice: micros(8_000),
    unit: 'per_megapixel',
    pricingNotes:
      '- **Price**: $0.008 per megapixels\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
  },
  'fal-ai/flux-2/turbo/edit': {
    basePrice: micros(8_000),
    unit: 'per_image',
  },
  'fal-ai/hidream-i1-full': {
    basePrice: micros(50_000),
    unit: 'per_megapixel',
    pricingNotes:
      '- **Price**: $0.05 per megapixels\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
  },
  'fal-ai/hunyuan-image/v3/instruct/edit': {
    basePrice: micros(1_670),
    unit: 'per_compute_second',
  },
  'fal-ai/hunyuan-image/v3/text-to-image': {
    basePrice: micros(100_000),
    unit: 'per_megapixel',
  },
  'fal-ai/nano-banana-2': {
    basePrice: micros(80_000),
    unit: 'per_image',
    resolutionMultipliers: {
      '0.5K': 0.75,
      '1K': 1,
      '2K': 1.5,
      '4K': 2,
    },
    surcharges: {
      webSearch: micros(15_000),
    },
    pricingNotes:
      'Your request will cost **$0.08** per image. For **$1.00**, you can run this model **12** times. 2K and 4K outputs will be charged at **1.5** times and **2** times the standard rate, respectively. 0.5K (512px) resolution outputs will be charged at **0.75** times the standard rate. If web search is used, an additional $0.015 will be charged. **Note: Pricing is subject to change.**\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
  },
  'fal-ai/nano-banana-2/edit': {
    basePrice: micros(80_000),
    unit: 'per_image',
    resolutionMultipliers: {
      '0.5K': 0.75,
      '1K': 1,
      '2K': 1.5,
      '4K': 2,
    },
    surcharges: {
      webSearch: micros(15_000),
    },
    pricingNotes:
      'Your request will cost **$0.08** per image. For **$1.00**, you can run this model **12** times. 2K and 4K outputs will be charged at **1.5** times and **2** times the standard rate, respectively. 0.5K (512px) resolution outputs will be charged at **0.75** times the standard rate. If web search is used, an additional $0.015 will be charged. **Note: Pricing is subject to change.**\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
  },
  'fal-ai/nano-banana-pro': {
    basePrice: micros(150_000),
    unit: 'per_image',
    resolutionMultipliers: {
      '4K': 2,
    },
    surcharges: {
      webSearch: micros(15_000),
    },
    pricingNotes:
      'Your request will cost **$0.15** per image. For **$1.00**, you can run this model **7** times. 4K outputs will be charged at double the standard rate. If web search is used, an additional $0.015 will be charged. Note: Pricing may change in the future.\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
  },
  'fal-ai/nano-banana-pro/edit': {
    basePrice: micros(150_000),
    unit: 'per_image',
    resolutionMultipliers: {
      '4K': 2,
    },
    surcharges: {
      webSearch: micros(15_000),
    },
    pricingNotes:
      'Your request will cost **$0.15** per image. For **$1.00**, you can run this model **7** times. 4K outputs will be charged at double the standard rate. If web search is used, an additional $0.015 will be charged. Note: Pricing may change in the future.\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
  },
  'fal-ai/phota': {
    basePrice: micros(90_000),
    unit: 'per_image',
  },
  'fal-ai/phota/edit': {
    basePrice: micros(90_000),
    unit: 'per_image',
  },
  'fal-ai/qwen-image-2/pro/edit': {
    basePrice: micros(75_000),
    unit: 'per_image',
  },
  'fal-ai/qwen-image-2/pro/text-to-image': {
    basePrice: micros(75_000),
    unit: 'per_image',
  },
  'openai/gpt-image-2': {
    basePrice: micros(1_000_000),
    unit: 'per_image',
  },
  'openai/gpt-image-2/edit': {
    basePrice: micros(1_000_000),
    unit: 'per_image',
  },
  'xai/grok-imagine-image/quality': {
    basePrice: micros(170),
    unit: 'per_compute_second',
  },
  'xai/grok-imagine-image/quality/edit': {
    basePrice: micros(170),
    unit: 'per_compute_second',
  },
};

// ============================================================================
// Video Pricing (all prices in microdollars: 1 USD = 1,000,000)
// ============================================================================

type VideoPricingBase = { pricingNotes?: string };

type VideoPricingPerSecond = VideoPricingBase & {
  mode: 'per_second';
  basePrice: Microdollars;
  noAudioMultiplier?: number;
  audioMultiplier?: number;
  voiceControlMultiplier?: number;
  resolutionPricing?: Record<string, Microdollars>;
  resolutionAudioPricing?: Record<
    string,
    { noAudio: Microdollars; withAudio: Microdollars }
  >;
  surcharges?: { imageInput?: Microdollars };
};

type VideoPricingPerToken = VideoPricingBase & {
  mode: 'per_token';
  pricePerMillionTokens: Microdollars;
};

export type VideoPricing = VideoPricingPerSecond | VideoPricingPerToken;

export const VIDEO_PRICING: Record<string, VideoPricing> = {
  'bytedance/seedance-2.0/image-to-video': {
    mode: 'per_second',
    basePrice: micros(14_000),
  },
  'fal-ai/bytedance/seedance/v1.5/pro/image-to-video': {
    mode: 'per_second',
    basePrice: micros(1_200_000),
  },
  'fal-ai/kling-video/v3/pro/image-to-video': {
    mode: 'per_second',
    basePrice: micros(140_000),
    noAudioMultiplier: 0.8,
    audioMultiplier: 1.2,
    voiceControlMultiplier: 1.4,
    pricingNotes:
      'For every second of video you generated, you will be charged **$0.112** (audio off) or **$0.168** (audio on), if voice control is used while generating audio you will be charged **$0.196**. For example, a 5s video with audio on and voice control will cost **$0.98**\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
  },
  'fal-ai/ltx-2.3/image-to-video': {
    mode: 'per_second',
    basePrice: micros(60_000),
  },
  'fal-ai/minimax/hailuo-02/pro/image-to-video': {
    mode: 'per_second',
    basePrice: micros(80_000),
  },
  'fal-ai/veo3.1/image-to-video': {
    mode: 'per_second',
    basePrice: micros(400_000),
    resolutionAudioPricing: {
      '720p': {
        noAudio: micros(200_000),
        withAudio: micros(400_000),
      },
      '1080p': {
        noAudio: micros(200_000),
        withAudio: micros(400_000),
      },
      '4K': {
        noAudio: micros(400_000),
        withAudio: micros(600_000),
      },
    },
    pricingNotes:
      'For every second of video you generate you will be charged **$0.20** without audio or **$0.40** with audio for 720p or 1080p. At 4k, you will be charged **$0.40** per second without audio, or **$0.60** with. For example, a **5 second video** at **1080p** with **audio on** will cost **$2.00**.\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
  },
  'xai/grok-imagine-video/image-to-video': {
    mode: 'per_second',
    basePrice: micros(50_000),
    resolutionPricing: {
      '480p': micros(50_000),
      '720p': micros(70_000),
    },
    surcharges: {
      imageInput: micros(2_000),
    },
    pricingNotes:
      'A 6s 480p video will cost **$0.302** (**$0.05** per second of 480p video + **$0.002** for image input). At an output resolution of 480p, every second costs **$0.05**, and at 720p, every second costs **$0.07**.\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
  },
};

// ============================================================================
// Audio Pricing (all prices in microdollars: 1 USD = 1,000,000)
// ============================================================================

type AudioPricingUnit = 'per_second' | 'per_minute' | 'per_compute_second';

export type AudioPricing = {
  basePrice: Microdollars;
  unit: AudioPricingUnit;
  roundUpToMinute?: boolean;
  pricingNotes?: string;
};

export const AUDIO_PRICING: Record<string, AudioPricing> = {
  'fal-ai/ace-step-1.5': {
    basePrice: micros(300),
    unit: 'per_second',
    pricingNotes:
      'Your request will cost $0.0003 per output second.\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
  },
  'fal-ai/ace-step/prompt-to-audio': {
    basePrice: micros(200),
    unit: 'per_second',
    pricingNotes:
      'Your request will cost $0.0002 per second of generated audio. For $1 you can run generate 5000 seconds (83 minutes) of music from lyrics.\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
  },
  'fal-ai/elevenlabs/music': {
    basePrice: micros(800_000),
    unit: 'per_minute',
    roundUpToMinute: true,
    pricingNotes:
      'Your request will cost **$0.8** per output audio minute. The audio will be **rounded up** to the closest minute. For instance, a generation with 30 seconds output will be billed as 1 minute.\n\nFor more details, see [fal.ai pricing](https://fal.ai/pricing).',
  },
};

export const PRICING_LAST_UPDATED = '2026-05-07T00:04:14.149Z';
