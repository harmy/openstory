/**
 * Fetch live pricing from fal.ai and write src/lib/ai/fal-pricing-data.ts
 * Usage:
 *   bun scripts/update-fal-pricing.ts            # API pricing only
 *   bun scripts/update-fal-pricing.ts --llms-txt  # Also fetch llms.txt pricing notes
 */
import { getEnv } from '#env';
import {
  AUDIO_MODELS,
  EDIT_ENDPOINTS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
} from '@/lib/ai/models';
import { typedEntries } from '@/lib/utils/typed-object';
import { getFalEndpointIds } from './fal-endpoints';

/**
 * Wrapper to tag numeric values that should be serialized as `X as Microdollars`
 * in the generated output file. Multipliers stay as plain numbers.
 */
class MicrosValue {
  constructor(readonly value: number) {}
}

/** Convert USD to a MicrosValue for serialization tagging */
const m = (usd: number): MicrosValue =>
  new MicrosValue(Math.round(usd * 1_000_000));

// ============================================================================
// Builder types — mirror the output types but with MicrosValue for price fields
// ============================================================================

type BuilderImagePricing = {
  basePrice: MicrosValue;
  unit: 'per_image' | 'per_megapixel' | 'per_compute_second';
  resolutionMultipliers?: Partial<Record<'0.5K' | '1K' | '2K' | '4K', number>>;
  styleMultipliers?: Record<string, number>;
  qualitySizeMatrix?: Record<string, Record<string, MicrosValue>>;
  surcharges?: { webSearch?: MicrosValue };
  pricingNotes?: string;
};

type BuilderVideoPricingPerSecond = {
  mode: 'per_second';
  basePrice: MicrosValue;
  noAudioMultiplier?: number;
  audioMultiplier?: number;
  voiceControlMultiplier?: number;
  resolutionPricing?: Record<string, MicrosValue>;
  resolutionAudioPricing?: Record<
    string,
    { noAudio: MicrosValue; withAudio: MicrosValue }
  >;
  surcharges?: { imageInput?: MicrosValue };
  pricingNotes?: string;
};

type BuilderVideoPricingPerToken = {
  mode: 'per_token';
  pricePerMillionTokens: MicrosValue;
  pricingNotes?: string;
};

type BuilderVideoPricing =
  | BuilderVideoPricingPerSecond
  | BuilderVideoPricingPerToken;

type BuilderAudioPricing = {
  basePrice: MicrosValue;
  unit: 'per_second' | 'per_minute' | 'per_compute_second';
  roundUpToMinute?: boolean;
  pricingNotes?: string;
};

const fetchLlmsTxt = process.argv.includes('--llms-txt');

const apiKey = getEnv().FAL_KEY;
if (!apiKey) {
  console.error('FAL_KEY not set');
  process.exit(1);
}

const endpoints = getFalEndpointIds();

// ============================================================================
// Classify endpoints into image/video/audio
// ============================================================================

const imageEndpointIds = new Set<string>(
  Object.values(IMAGE_MODELS).map((m) => m.id)
);
// Include edit endpoints from the single source of truth
for (const editId of Object.values(EDIT_ENDPOINTS)) {
  if (editId) imageEndpointIds.add(editId);
}

const videoEndpointIds = new Set<string>(
  Object.values(IMAGE_TO_VIDEO_MODELS).map((m) => m.id)
);

const audioEndpointIds = new Set<string>(
  Object.values(AUDIO_MODELS).map((m) => m.id)
);

function classifyEndpoint(id: string): 'image' | 'video' | 'audio' | 'unknown' {
  if (imageEndpointIds.has(id)) return 'image';
  if (videoEndpointIds.has(id)) return 'video';
  if (audioEndpointIds.has(id)) return 'audio';
  return 'unknown';
}

// ============================================================================
// Manual overrides — conditional pricing that can't be auto-derived from API
// ============================================================================

const IMAGE_OVERRIDES: Record<string, Partial<BuilderImagePricing>> = {
  'fal-ai/nano-banana-2': {
    resolutionMultipliers: { '0.5K': 0.75, '1K': 1, '2K': 1.5, '4K': 2 },
    surcharges: { webSearch: m(0.015) },
  },
  'fal-ai/nano-banana-2/edit': {
    resolutionMultipliers: { '0.5K': 0.75, '1K': 1, '2K': 1.5, '4K': 2 },
    surcharges: { webSearch: m(0.015) },
  },
  'fal-ai/nano-banana-pro': {
    resolutionMultipliers: { '4K': 2 },
    surcharges: { webSearch: m(0.015) },
  },
  'fal-ai/nano-banana-pro/edit': {
    resolutionMultipliers: { '4K': 2 },
    surcharges: { webSearch: m(0.015) },
  },
  'fal-ai/recraft/v3/text-to-image': {
    styleMultipliers: { vector_illustration: 2, vector: 2 },
  },
  'fal-ai/gpt-image-1.5': {
    basePrice: m(0), // Overridden by matrix
    qualitySizeMatrix: {
      // Prices from llms.txt + ~$0.01 buffer for prompt token processing costs
      low: {
        '1024x1024': m(0.02),
        '1024x1536': m(0.025),
        '1536x1024': m(0.025),
      },
      medium: {
        '1024x1024': m(0.045),
        '1024x1536': m(0.062),
        '1536x1024': m(0.061),
      },
      high: {
        '1024x1024': m(0.144),
        '1024x1536': m(0.211),
        '1536x1024': m(0.21),
      },
    },
  },
};

const VIDEO_OVERRIDES: Record<
  string,
  Partial<BuilderVideoPricingPerSecond> | { mode: 'per_token' }
> = {
  'fal-ai/veo3': {
    // API returns audio-on rate ($0.40); no multiplier needed
  },
  'fal-ai/veo3.1/image-to-video': {
    resolutionAudioPricing: {
      '720p': { noAudio: m(0.2), withAudio: m(0.4) },
      '1080p': { noAudio: m(0.2), withAudio: m(0.4) },
      '4K': { noAudio: m(0.4), withAudio: m(0.6) },
    },
  },
  'fal-ai/kling-video/v3/pro/image-to-video': {
    noAudioMultiplier: 0.8,
    audioMultiplier: 1.2,
    voiceControlMultiplier: 1.4,
  },
  'wan/v2.6/image-to-video/flash': {
    resolutionPricing: { '720p': m(0.05), '1080p': m(0.075) },
  },
  'xai/grok-imagine-video/image-to-video': {
    resolutionPricing: { '480p': m(0.05), '720p': m(0.07) },
    surcharges: { imageInput: m(0.002) },
  },
  'fal-ai/bytedance/seedance/v1/pro/image-to-video': {
    mode: 'per_token',
  },
};

const AUDIO_OVERRIDES: Record<string, Partial<BuilderAudioPricing>> = {
  'fal-ai/elevenlabs/music': {
    roundUpToMinute: true,
  },
};

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
// Read existing file for diff and pricingNotes preservation
// ============================================================================

const outPath = new URL('../src/lib/ai/fal-pricing-data.ts', import.meta.url)
  .pathname;

type OldPricingEntry = {
  basePrice?: number;
  pricePerMillionTokens?: number;
  pricingNotes?: string;
};
let oldImagePricing: Record<string, OldPricingEntry> = {};
let oldVideoPricing: Record<string, OldPricingEntry> = {};
let oldAudioPricing: Record<string, OldPricingEntry> = {};
try {
  const existing = await import(outPath);
  oldImagePricing = existing.IMAGE_PRICING ?? {};
  oldVideoPricing = existing.VIDEO_PRICING ?? {};
  oldAudioPricing = existing.AUDIO_PRICING ?? {};
} catch {
  // First run — no existing file
}

// ============================================================================
// Build pricing maps (prices wrapped in MicrosValue for serialization)
// ============================================================================

const imagePricing: Record<string, BuilderImagePricing> = {};
const videoPricing: Record<string, BuilderVideoPricing> = {};
const audioPricing: Record<string, BuilderAudioPricing> = {};

function mapImageUnit(
  apiUnit: string
): 'per_image' | 'per_megapixel' | 'per_compute_second' {
  const u = apiUnit.toLowerCase();
  if (u === 'megapixels') return 'per_megapixel';
  if (u === 'compute seconds') return 'per_compute_second';
  return 'per_image';
}

function mapAudioUnit(
  apiUnit: string
): 'per_second' | 'per_minute' | 'per_compute_second' {
  const u = apiUnit.toLowerCase();
  if (u === 'minutes') return 'per_minute';
  if (u === 'compute seconds') return 'per_compute_second';
  return 'per_second';
}

for (const p of data.prices.sort((a, b) =>
  a.endpoint_id.localeCompare(b.endpoint_id)
)) {
  const type = classifyEndpoint(p.endpoint_id);

  switch (type) {
    case 'image': {
      const override = IMAGE_OVERRIDES[p.endpoint_id];
      imagePricing[p.endpoint_id] = {
        basePrice: override.basePrice ?? m(p.unit_price),
        unit: override.unit ?? mapImageUnit(p.unit),
        ...override,
      };
      break;
    }
    case 'video': {
      const override = VIDEO_OVERRIDES[p.endpoint_id];
      if ('mode' in override && override.mode === 'per_token') {
        videoPricing[p.endpoint_id] = {
          mode: 'per_token',
          pricePerMillionTokens: m(p.unit_price),
        };
      } else {
        const secOverride = override as
          | Partial<BuilderVideoPricingPerSecond>
          | undefined;
        videoPricing[p.endpoint_id] = {
          mode: 'per_second',
          basePrice: secOverride?.basePrice ?? m(p.unit_price),
          ...secOverride,
        };
      }
      break;
    }
    case 'audio': {
      const override = AUDIO_OVERRIDES[p.endpoint_id];
      audioPricing[p.endpoint_id] = {
        basePrice: m(p.unit_price),
        unit: override.unit ?? mapAudioUnit(p.unit),
        ...override,
      };
      break;
    }
    default:
      console.warn(`  ? ${p.endpoint_id}: unclassified, skipping`);
  }
}

// ============================================================================
// Fetch llms.txt pricing notes
// ============================================================================

type PricingEntry = { pricingNotes?: string };
const allPricing = new Map<string, PricingEntry>();
for (const [id, p] of typedEntries(imagePricing)) allPricing.set(id, p);
for (const [id, p] of typedEntries(videoPricing)) allPricing.set(id, p);
for (const [id, p] of typedEntries(audioPricing)) allPricing.set(id, p);

if (fetchLlmsTxt) {
  console.log('\nFetching llms.txt pricing notes...\n');

  const falEndpoints = endpoints.filter(
    (id) =>
      id.startsWith('fal-ai/') ||
      id.startsWith('xai/') ||
      id.startsWith('wan/') ||
      id.startsWith('beatoven/')
  );

  const results = await Promise.allSettled(
    falEndpoints.map(async (endpointId) => {
      const llmsUrl = `https://fal.ai/models/${endpointId}/llms.txt`;
      const res = await fetch(llmsUrl);
      if (!res.ok) return { endpointId, notes: null };
      const text = await res.text();
      return { endpointId, notes: text };
    })
  );

  for (const result of results) {
    if (result.status !== 'fulfilled' || !result.value.notes) {
      const id =
        result.status === 'fulfilled' ? result.value.endpointId : 'unknown';
      console.log(`  \u23ED ${id}: no llms.txt`);
      continue;
    }

    const { endpointId, notes } = result.value;

    const pricingMatch = notes.match(
      /## Pricing\s*\n([\s\S]*?)(?=\n## |\n# |$)/
    );
    if (!pricingMatch) {
      console.log(`  \u23ED ${endpointId}: no pricing section`);
      continue;
    }

    const pricingText = pricingMatch[1].trim();
    console.log(`  \u2713 ${endpointId}:`);
    console.log(`    ${pricingText.split('\n').join('\n    ')}\n`);

    const entry = allPricing.get(endpointId);
    if (entry) {
      entry.pricingNotes = pricingText;
    }
  }
}

// Preserve existing pricingNotes when not fetching llms.txt
if (!fetchLlmsTxt) {
  for (const [id, entry] of typedEntries(imagePricing)) {
    const old = oldImagePricing[id];
    if (old.pricingNotes && !entry.pricingNotes) {
      entry.pricingNotes = old.pricingNotes;
    }
  }
  for (const [id, entry] of typedEntries(videoPricing)) {
    const old = oldVideoPricing[id];
    if (old.pricingNotes && !entry.pricingNotes) {
      entry.pricingNotes = old.pricingNotes;
    }
  }
  for (const [id, entry] of typedEntries(audioPricing)) {
    const old = oldAudioPricing[id];
    if (old.pricingNotes && !entry.pricingNotes) {
      entry.pricingNotes = old.pricingNotes;
    }
  }
}

// ============================================================================
// Log diff summary
// ============================================================================

let changes = 0;

function getBasePrice(entry: OldPricingEntry): number {
  return entry.basePrice ?? entry.pricePerMillionTokens ?? 0;
}

function getMicrosBasePrice(
  entry: BuilderImagePricing | BuilderVideoPricing | BuilderAudioPricing
): number {
  if ('basePrice' in entry) return entry.basePrice.value;
  if ('pricePerMillionTokens' in entry)
    return entry.pricePerMillionTokens.value;
  return 0;
}

function diffMap(
  label: string,
  newIds: string[],
  oldIds: string[],
  getNew: (id: string) => number,
  getOld: (id: string) => number | undefined
) {
  for (const id of newIds) {
    const bp = getNew(id);
    const oldBp = getOld(id);
    if (oldBp === undefined) {
      console.log(`  + [${label}] ${id}: ${bp} micros (new)`);
      changes++;
    } else if (oldBp !== bp) {
      console.log(`  ~ [${label}] ${id}: ${oldBp} → ${bp} micros`);
      changes++;
    }
  }
  for (const id of oldIds) {
    if (!newIds.includes(id)) {
      console.log(`  - [${label}] ${id}: removed`);
      changes++;
    }
  }
}

diffMap(
  'image',
  Object.keys(imagePricing),
  Object.keys(oldImagePricing),
  (id) => getMicrosBasePrice(imagePricing[id]),
  (id) => getBasePrice(oldImagePricing[id])
);
diffMap(
  'video',
  Object.keys(videoPricing),
  Object.keys(oldVideoPricing),
  (id) => getMicrosBasePrice(videoPricing[id]),
  (id) => getBasePrice(oldVideoPricing[id])
);
diffMap(
  'audio',
  Object.keys(audioPricing),
  Object.keys(oldAudioPricing),
  (id) => getMicrosBasePrice(audioPricing[id]),
  (id) => getBasePrice(oldAudioPricing[id])
);

// ============================================================================
// Write the generated file
// ============================================================================

function escapeString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
}

/** Format large integers with underscore separators for readability */
function formatMicros(value: number): string {
  if (value === 0) return '0';
  const str = String(value);
  // Add underscore separators for values >= 1000
  if (value >= 1000) {
    return str.replace(/\B(?=(\d{3})+(?!\d))/g, '_');
  }
  return str;
}

function serializeValue(value: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  const padInner = '  '.repeat(indent + 1);

  if (value === undefined || value === null) return 'undefined';
  if (value instanceof MicrosValue)
    return `micros(${formatMicros(value.value)})`;
  if (typeof value === 'string') return `'${escapeString(value)}'`;
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value);

  if (Array.isArray(value)) {
    const items = value.map((v) => serializeValue(v, indent + 1));
    return `[${items.join(', ')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined);
    if (entries.length === 0) return '{}';
    const lines = entries.map(
      ([k, v]) => `${padInner}${quoteKey(k)}: ${serializeValue(v, indent + 1)}`
    );
    return `{\n${lines.join(',\n')},\n${pad}}`;
  }

  return JSON.stringify(value);
}

function quoteKey(key: string): string {
  return /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? key : `'${key}'`;
}

function serializeMap(
  name: string,
  type: string,
  map: Record<
    string,
    BuilderImagePricing | BuilderVideoPricing | BuilderAudioPricing
  >
): string {
  const entries = Object.entries(map)
    .map(([id, p]) => `  '${id}': ${serializeValue(p, 1)},`)
    .join('\n');

  return `export const ${name}: Record<string, ${type}> = {\n${entries}\n};`;
}

const now = new Date().toISOString();
const output = `// AUTO-GENERATED — do not edit manually. Run: bun scripts/update-fal-pricing.ts
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

${serializeMap('IMAGE_PRICING', 'ImagePricing', imagePricing)}

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
  resolutionAudioPricing?: Record<string, { noAudio: Microdollars; withAudio: Microdollars }>;
  surcharges?: { imageInput?: Microdollars };
};

type VideoPricingPerToken = VideoPricingBase & {
  mode: 'per_token';
  pricePerMillionTokens: Microdollars;
};

export type VideoPricing = VideoPricingPerSecond | VideoPricingPerToken;

${serializeMap('VIDEO_PRICING', 'VideoPricing', videoPricing)}

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

${serializeMap('AUDIO_PRICING', 'AudioPricing', audioPricing)}

export const PRICING_LAST_UPDATED = '${now}';
`;

await Bun.write(outPath, output);

const total =
  Object.keys(imagePricing).length +
  Object.keys(videoPricing).length +
  Object.keys(audioPricing).length;
console.log(
  `\nWrote ${total} endpoints to fal-pricing-data.ts (${changes} changes)`
);
console.log(
  `  Image: ${Object.keys(imagePricing).length}, Video: ${Object.keys(videoPricing).length}, Audio: ${Object.keys(audioPricing).length}`
);
