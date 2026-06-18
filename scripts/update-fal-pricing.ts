/**
 * Fetch live pricing from fal.ai and write src/lib/ai/fal-pricing-data.ts
 * Usage:
 *   bun scripts/update-fal-pricing.ts
 *
 * The output is a single flat map of `endpointId -> { unitPrice, unit }` taken
 * verbatim from fal's pricing API. Actual credit deduction multiplies fal's
 * reported `unitsBilled` by `unitPrice` (see `falCostFromUnits` in
 * `src/lib/ai/fal-cost.ts`), so no per-model multipliers/matrices are needed —
 * fal already accounts for resolution/audio/duration in `unitsBilled`. The
 * `unit` field is only used by pre-flight cost ESTIMATION to predict a unit
 * count before a generation runs.
 */
import { writeFile } from 'node:fs/promises';
import { getEnv } from '#env';
import { getFalEndpointIds } from './fal-endpoints';

/**
 * Wrapper to tag numeric values that should be serialized as `micros(X)` in the
 * generated output file.
 */
class MicrosValue {
  constructor(readonly value: number) {}
}

/** Convert USD to a MicrosValue for serialization tagging */
const m = (usd: number): MicrosValue =>
  new MicrosValue(Math.round(usd * 1_000_000));

type FalUnit =
  | 'images'
  | 'megapixels'
  | 'compute_seconds'
  | 'seconds'
  | 'minutes'
  | 'tokens'
  | 'flat';

type BuilderFalPricing = { unitPrice: MicrosValue; unit: FalUnit };

const apiKey = getEnv().FAL_KEY;
if (!apiKey) {
  console.error('FAL_KEY not set');
  process.exit(1);
}

const endpoints = getFalEndpointIds();

// ============================================================================
// "units" disambiguation
//
// The pricing API reports the ambiguous unit `"units"` for several distinct
// billing kinds (e.g. flat-per-video, per-1000-token, per-image, and per-second
// all show up as "units"). Tag the known ones so pre-flight ESTIMATION can
// predict a unit count. This never affects an actual charge — billing always
// multiplies fal's reported `unitsBilled` by `unitPrice` regardless of `unit`.
// ============================================================================

const UNITS_KIND: Record<string, FalUnit> = {
  'openai/gpt-image-2': 'images',
  'openai/gpt-image-2/edit': 'images',
  'fal-ai/phota': 'images',
  'fal-ai/phota/edit': 'images',
  'fal-ai/ace-step-1.5': 'seconds',
  'fal-ai/minimax/hailuo-2.3/pro/image-to-video': 'flat',
  'bytedance/seedance-2.0/enterprise/v2/image-to-video': 'tokens',
};

function normalizeUnit(apiUnit: string, endpointId: string): FalUnit {
  const u = apiUnit.toLowerCase();
  // The bare "units" is ambiguous (flat / per-image / per-1000-token all report
  // it), so it must be tagged in UNITS_KIND. Everything else is recognised by
  // substring so variants like "processed megapixels" still resolve.
  if (u === 'units') {
    const kind = UNITS_KIND[endpointId];
    if (!kind) {
      console.warn(
        `  ? ${endpointId}: unit "units" with no kind override — defaulting to 'flat' (estimation only)`
      );
      return 'flat';
    }
    return kind;
  }
  if (u.includes('megapixel')) return 'megapixels';
  if (u.includes('compute second')) return 'compute_seconds';
  if (u.includes('second')) return 'seconds';
  if (u.includes('minute')) return 'minutes';
  if (u.includes('image')) return 'images';
  console.warn(
    `  ? ${endpointId}: unknown unit "${apiUnit}" — defaulting to 'flat' (estimation only)`
  );
  return 'flat';
}

// ============================================================================
// Fetch pricing from API
// ============================================================================

const url = new URL('https://api.fal.ai/v1/models/pricing');
url.searchParams.set('endpoint_id', endpoints.join(','));

const response = await fetch(url.toString(), {
  headers: { Authorization: `Key ${apiKey}` },
});

if (!response.ok) {
  console.error(`HTTP ${response.status}: ${await response.text()}`);
  process.exit(1);
}

type PriceEntry = {
  endpoint_id: string;
  unit_price: number;
  unit: string;
  currency: string;
};

const data: { prices: PriceEntry[] } = await response.json();

// Check for missing endpoints
const found = new Set(data.prices.map((p) => p.endpoint_id));
const missing = endpoints.filter((e) => !found.has(e));
if (missing.length > 0) {
  console.error('\nERROR: Missing endpoints from fal pricing API:');
  for (const ep of missing) console.error(`  - ${ep}`);
  process.exit(1);
}

// ============================================================================
// Read existing file for a price-change diff
// ============================================================================

const outPath = new URL('../src/lib/ai/fal-pricing-data.ts', import.meta.url)
  .pathname;

let oldPricing: Record<string, { unitPrice?: number }> = {};
try {
  const existing = await import(outPath);
  oldPricing = existing.FAL_PRICING ?? {};
} catch {
  // First run — no existing file
}

// ============================================================================
// Build the flat pricing map (prices wrapped in MicrosValue for serialization)
// ============================================================================

const pricing: Record<string, BuilderFalPricing> = {};
for (const p of data.prices.sort((a, b) =>
  a.endpoint_id.localeCompare(b.endpoint_id)
)) {
  pricing[p.endpoint_id] = {
    unitPrice: m(p.unit_price),
    unit: normalizeUnit(p.unit, p.endpoint_id),
  };
}

// ============================================================================
// Log diff summary
// ============================================================================

let changes = 0;
for (const [id, entry] of Object.entries(pricing)) {
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- Record lookup returns undefined for missing keys
  const old = oldPricing[id];
  const newPrice = entry.unitPrice.value;
  if (!old) {
    console.log(`  + ${id}: ${newPrice} micros (new)`);
    changes++;
  } else if (old.unitPrice !== newPrice) {
    console.log(`  ~ ${id}: ${old.unitPrice} → ${newPrice} micros`);
    changes++;
  }
}
for (const id of Object.keys(oldPricing)) {
  if (!(id in pricing)) {
    console.log(`  - ${id}: removed`);
    changes++;
  }
}

// ============================================================================
// Write the generated file
// ============================================================================

/** Format large integers with underscore separators for readability */
function formatMicros(value: number): string {
  if (value === 0) return '0';
  const str = String(value);
  if (value >= 1000) {
    return str.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
  }
  return str;
}

const entries = Object.entries(pricing)
  .map(
    ([id, p]) =>
      `  '${id}': { unitPrice: micros(${formatMicros(p.unitPrice.value)}), unit: '${p.unit}' },`
  )
  .join('\n');

const now = new Date().toISOString();
const output = `// AUTO-GENERATED — do not edit manually. Run: bun scripts/update-fal-pricing.ts
// The "units" disambiguation map is maintained in scripts/update-fal-pricing.ts

import { type Microdollars, micros } from '@/lib/billing/money';

// ============================================================================
// Fal Pricing (all prices in microdollars: 1 USD = 1,000,000)
//
// \`unitPrice\` is fal's per-unit price, taken verbatim from the pricing API.
// Actual cost = unitsBilled (from the adapter) * unitPrice. \`unit\` is the
// billed unit, used only by pre-flight cost estimation.
// ============================================================================

export type FalUnit =
  | 'images'
  | 'megapixels'
  | 'compute_seconds'
  | 'seconds'
  | 'minutes'
  | 'tokens'
  | 'flat';

export type FalPricing = {
  unitPrice: Microdollars;
  unit: FalUnit;
};

export const FAL_PRICING: Record<string, FalPricing> = {
${entries}
};

export const PRICING_LAST_UPDATED = '${now}';
`;

await writeFile(outPath, output);

console.log(
  `\nWrote ${Object.keys(pricing).length} endpoints to fal-pricing-data.ts (${changes} changes)`
);
