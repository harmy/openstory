import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ai', 'fal-cost']);
/**
 * Fal.ai cost calculation.
 *
 * Billing is exact: fal reports the quantity it billed for a generation as
 * `unitsBilled` (via the `x-fal-billable-units` header, surfaced by the TanStack
 * AI adapter), denominated in the endpoint's priced unit. The cost is simply
 * `unitsBilled * unitPrice` — fal already accounts for resolution, audio,
 * duration, etc. in the unit count, so no per-model multipliers are needed.
 *
 * `estimateFalCost` predicts a cost BEFORE a generation runs (no `unitsBilled`
 * yet) for the pre-flight credit gate. It is deliberately rough.
 */

import { FAL_PRICING } from '@/lib/ai/fal-pricing-data';
import {
  type Microdollars,
  ZERO_MICROS,
  multiplyMicros,
} from '@/lib/billing/money';

/** Default compute time estimate for compute_seconds-priced models */
const DEFAULT_COMPUTE_SECONDS = 3;

/** Assumed 16:9 output dimensions per resolution tier for token-priced models */
const TOKEN_RESOLUTION_DIMENSIONS: Record<
  string,
  { width: number; height: number }
> = {
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

// ============================================================================
// Actual cost (billing) — unitsBilled * unitPrice
// ============================================================================

/**
 * Exact fal cost for a completed generation: `unitsBilled * unitPrice`.
 *
 * Returns `ZERO_MICROS` and logs an error when pricing is missing or fal did
 * not report `unitsBilled` — we charge nothing rather than guess, so a usage
 * regression surfaces loudly instead of silently mis-billing.
 */
export function falCostFromUnits(
  endpointId: string,
  unitsBilled: number | undefined
): Microdollars {
  const pricing = FAL_PRICING[endpointId];
  if (!pricing) {
    logger.error(`No fal pricing data for endpoint: ${endpointId}`);
    return ZERO_MICROS;
  }
  if (unitsBilled == null || !Number.isFinite(unitsBilled)) {
    logger.error(
      `No unitsBilled reported for ${endpointId} — charging nothing`,
      { unitsBilled }
    );
    return ZERO_MICROS;
  }
  return multiplyMicros(pricing.unitPrice, unitsBilled);
}

// ============================================================================
// Pre-flight estimation — predicts a unit count from generation params
// ============================================================================

export type FalCostEstimateParams = {
  numImages?: number;
  durationSeconds?: number;
  widthPx?: number;
  heightPx?: number;
  fps?: number;
  resolution?: string;
};

/**
 * Rough pre-flight cost estimate, used only for the credit-availability gate
 * before a generation runs. Predicts the billed unit count from the requested
 * parameters, then multiplies by `unitPrice`. Audio/resolution premiums are
 * intentionally ignored — the exact charge comes from `falCostFromUnits` once
 * fal reports `unitsBilled`.
 */
export function estimateFalCost(
  endpointId: string,
  params: FalCostEstimateParams
): Microdollars {
  const pricing = FAL_PRICING[endpointId];
  if (!pricing) {
    logger.error(`No fal pricing data for endpoint: ${endpointId}`);
    return ZERO_MICROS;
  }

  const numImages = params.numImages ?? 1;
  const duration = params.durationSeconds ?? 0;

  switch (pricing.unit) {
    case 'images':
    case 'flat':
      return multiplyMicros(pricing.unitPrice, numImages);

    case 'megapixels': {
      const w = params.widthPx ?? 1024;
      const h = params.heightPx ?? 1024;
      const megapixels = (w * h) / 1_000_000;
      return multiplyMicros(pricing.unitPrice, megapixels * numImages);
    }

    case 'compute_seconds':
      return multiplyMicros(
        pricing.unitPrice,
        DEFAULT_COMPUTE_SECONDS * numImages
      );

    case 'seconds':
      return multiplyMicros(pricing.unitPrice, duration);

    case 'minutes':
      return multiplyMicros(pricing.unitPrice, Math.ceil(duration / 60));

    case 'tokens': {
      const dims = params.resolution
        ? TOKEN_RESOLUTION_DIMENSIONS[params.resolution]
        : undefined;
      const w = params.widthPx ?? dims?.width ?? 1920;
      const h = params.heightPx ?? dims?.height ?? 1080;
      const fps = params.fps ?? 24;
      // fal derives tokens from pixels (≈ w·h·fps·sec / 1024) and prices per
      // 1000-token unit; ~5% overhead on nominal shots.
      const units = ((w * h * fps * duration) / 1024 / 1000) * 1.05;
      return multiplyMicros(pricing.unitPrice, units);
    }

    default: {
      // Exhaustiveness guard: a new FalUnit without a case fails to compile.
      const _exhaustive: never = pricing.unit;
      return _exhaustive;
    }
  }
}
