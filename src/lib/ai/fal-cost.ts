/**
 * Type-safe fal.ai cost calculation with per-output-type pricing.
 *
 * Three domain-specific functions accept real generation parameters
 * instead of generic quantity/unit pairs. All return Microdollars.
 */

import {
  IMAGE_PRICING,
  VIDEO_PRICING,
  AUDIO_PRICING,
  type ImagePricing,
  type VideoPricing,
  type AudioPricing,
} from '@/lib/ai/fal-pricing-data';
import {
  type Microdollars,
  ZERO_MICROS,
  multiplyMicros,
  addMicros,
} from '@/lib/billing/money';

/** Default compute time estimate for compute_seconds-priced models */
const DEFAULT_COMPUTE_SECONDS = 3;

// ============================================================================
// Image Cost
// ============================================================================

export type ImageCostParams = {
  endpointId: string;
  numImages: number;
  widthPx?: number;
  heightPx?: number;
  resolution?: '0.5K' | '1K' | '2K' | '4K';
  style?: string;
  quality?: string;
  imageSize?: string;
};

export function calculateImageCost(params: ImageCostParams): Microdollars {
  const pricing = IMAGE_PRICING[params.endpointId] as ImagePricing | undefined;
  if (!pricing) {
    console.error(
      `[fal-cost] No image pricing data for endpoint: ${params.endpointId}`
    );
    return ZERO_MICROS;
  }

  // Quality/size matrix (e.g. GPT Image 1.5)
  if (pricing.qualitySizeMatrix && params.quality && params.imageSize) {
    const qualityPrices = pricing.qualitySizeMatrix[params.quality];
    if (qualityPrices) {
      const price = qualityPrices[params.imageSize];
      if (price !== undefined) {
        return multiplyMicros(price, params.numImages);
      }
    }
    // Fall through to base price if matrix doesn't match
  }

  if (pricing.unit === 'per_megapixel') {
    const w = params.widthPx ?? 1024;
    const h = params.heightPx ?? 1024;
    const megapixels = (w * h) / 1_000_000;
    return multiplyMicros(pricing.basePrice, megapixels * params.numImages);
  }

  if (pricing.unit === 'per_compute_second') {
    return multiplyMicros(
      pricing.basePrice,
      DEFAULT_COMPUTE_SECONDS * params.numImages
    );
  }

  // per_image
  let cost = multiplyMicros(pricing.basePrice, params.numImages);

  // Apply resolution multiplier
  if (pricing.resolutionMultipliers && params.resolution) {
    const mult = pricing.resolutionMultipliers[params.resolution];
    if (mult !== undefined) cost = multiplyMicros(cost, mult);
  }

  // Apply style multiplier
  if (pricing.styleMultipliers && params.style) {
    const mult = pricing.styleMultipliers[params.style];
    if (mult !== undefined) cost = multiplyMicros(cost, mult);
  }

  return cost;
}

// ============================================================================
// Video Cost
// ============================================================================

export type VideoCostParams = {
  endpointId: string;
  durationSeconds: number;
  audioEnabled?: boolean;
  voiceControl?: boolean;
  resolution?: string;
  widthPx?: number;
  heightPx?: number;
  fps?: number;
};

export function calculateVideoCost(params: VideoCostParams): Microdollars {
  const pricing = VIDEO_PRICING[params.endpointId] as VideoPricing | undefined;
  if (!pricing) {
    console.error(
      `[fal-cost] No video pricing data for endpoint: ${params.endpointId}`
    );
    return ZERO_MICROS;
  }

  if (pricing.mode === 'per_token') {
    return calculateTokenBasedVideoCost(pricing, params);
  }

  return calculateSecondBasedVideoCost(pricing, params);
}

function calculateTokenBasedVideoCost(
  pricing: Extract<VideoPricing, { mode: 'per_token' }>,
  params: VideoCostParams
): Microdollars {
  const w = params.widthPx ?? 1920;
  const h = params.heightPx ?? 1080;
  const fps = params.fps ?? 24;
  const tokens = (w * h * fps * params.durationSeconds) / 1024;
  // Actual rendered frames slightly exceed nominal fps (~3% overhead)
  const millionTokens = (tokens / 1_000_000) * 1.05;
  return multiplyMicros(pricing.pricePerMillionTokens, millionTokens);
}

function calculateSecondBasedVideoCost(
  pricing: Extract<VideoPricing, { mode: 'per_second' }>,
  params: VideoCostParams
): Microdollars {
  let rate = pricing.basePrice;

  // Resolution+audio matrix (e.g. Veo 3.1)
  if (pricing.resolutionAudioPricing && params.resolution) {
    const resPricing = pricing.resolutionAudioPricing[params.resolution];
    if (resPricing) {
      rate = params.audioEnabled ? resPricing.withAudio : resPricing.noAudio;
      let cost = multiplyMicros(rate, params.durationSeconds);
      if (pricing.surcharges?.imageInput) {
        cost = addMicros(cost, pricing.surcharges.imageInput);
      }
      return cost;
    }
  }

  // Resolution-only pricing (e.g. Wan Flash, Grok Video)
  if (pricing.resolutionPricing && params.resolution) {
    const resRate = pricing.resolutionPricing[params.resolution];
    if (resRate !== undefined) rate = resRate;
  }

  // Audio/voice multipliers (e.g. Kling v3 Pro, Veo3)
  if (params.voiceControl && pricing.voiceControlMultiplier) {
    rate = multiplyMicros(pricing.basePrice, pricing.voiceControlMultiplier);
  } else if (params.audioEnabled && pricing.audioMultiplier) {
    rate = multiplyMicros(pricing.basePrice, pricing.audioMultiplier);
  } else if (!params.audioEnabled && pricing.noAudioMultiplier) {
    rate = multiplyMicros(pricing.basePrice, pricing.noAudioMultiplier);
  }

  let cost = multiplyMicros(rate, params.durationSeconds);

  // Image input surcharge (e.g. Grok Video)
  if (pricing.surcharges?.imageInput) {
    cost = addMicros(cost, pricing.surcharges.imageInput);
  }

  return cost;
}

// ============================================================================
// Audio Cost
// ============================================================================

export type AudioCostParams = {
  endpointId: string;
  durationSeconds: number;
};

export function calculateAudioCost(params: AudioCostParams): Microdollars {
  const pricing = AUDIO_PRICING[params.endpointId] as AudioPricing | undefined;
  if (!pricing) {
    console.error(
      `[fal-cost] No audio pricing data for endpoint: ${params.endpointId}`
    );
    return ZERO_MICROS;
  }

  if (pricing.roundUpToMinute) {
    return multiplyMicros(
      pricing.basePrice,
      Math.ceil(params.durationSeconds / 60)
    );
  }

  if (pricing.unit === 'per_second') {
    return multiplyMicros(pricing.basePrice, params.durationSeconds);
  }

  if (pricing.unit === 'per_minute') {
    return multiplyMicros(pricing.basePrice, params.durationSeconds / 60);
  }

  // per_compute_second
  return multiplyMicros(pricing.basePrice, DEFAULT_COMPUTE_SECONDS);
}
