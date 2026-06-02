/**
 * Detect newer versions of the AI models (and AI SDK packages) we already use.
 *
 * Reads our four model registries plus the @tanstack/ai* deps in package.json,
 * then queries public, unauthenticated endpoints to find newer sibling versions:
 *   - fal.ai catalog      → https://fal.ai/api/models?keywords=…&category=…
 *   - OpenRouter catalog  → https://openrouter.ai/api/v1/models
 *   - npm registry        → https://registry.npmjs.org/<pkg>
 *
 * This is the deterministic backbone of the `update-model-versions` skill and
 * the daily "model freshness" routine. It only REPORTS candidates — deciding
 * whether a candidate is a genuine successor (vs a different product line) and
 * applying the bump is the skill's job. HTTP-only by design so it runs anywhere
 * (local, CI, or a headless cron agent) without genmedia/fal-MCP/FAL_KEY.
 *
 * Usage:
 *   bun scripts/check-model-updates.ts            # human-readable report
 *   bun scripts/check-model-updates.ts --json     # machine-readable JSON
 *
 * Exit code is 0 even when updates are found (it is a report, not a gate);
 * use the JSON `hasUpdates` field to branch in automation.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
} from '@/lib/ai/models';
import { SCRIPT_ANALYSIS_MODELS } from '@/lib/ai/models.config';

const jsonOutput = process.argv.includes('--json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Candidate = {
  id: string;
  title?: string;
  version: string | null;
};

type ModelReport = {
  source: 'fal-image' | 'fal-video' | 'fal-audio' | 'openrouter';
  key: string;
  currentId: string;
  currentVersion: string | null;
  /** Siblings in the same family that look NEWER than what we use. */
  newer: Candidate[];
  /** All same-family siblings, for context (may include older/variants). */
  family: Candidate[];
  error?: string;
};

type PackageReport = {
  source: 'npm';
  name: string;
  currentRange: string;
  currentResolved: string;
  latest: string | null;
  isOutdated: boolean;
  error?: string;
};

// ---------------------------------------------------------------------------
// Version helpers
// ---------------------------------------------------------------------------

const ORG_PREFIXES = new Set([
  'fal-ai',
  'xai',
  'x-ai',
  'openai',
  'google',
  'anthropic',
  'bytedance',
  'bytedance-seed',
  'z-ai',
  'deepseek',
  'mistralai',
  'meta-llama',
  'qwen',
  'minimax',
]);

/** Modality suffixes that are not part of the version/brand. */
const MODALITY_SUFFIXES =
  /\/(image-to-video|text-to-video|text-to-image|image-to-image|text-to-music|text-to-audio|text-to-speech|speech-to-text|reference-to-video|edit|pro|standard|lite|turbo|master|fast)$/;

/**
 * Leaf path segments that identify a model's modality/role. A candidate is only
 * treated as a successor if it shares the current model's leaf (apples-to-apples:
 * an image-to-video successor, not the same brand's text-to-video or TTS sibling).
 */
const MODALITY_LEAVES = new Set([
  'image-to-video',
  'text-to-video',
  'text-to-image',
  'image-to-image',
  'text-to-music',
  'music',
  'prompt-to-audio',
  'edit',
]);

/** Endpoint flavours that are not the primary base model (LoRA gear, trainers, etc.). */
const VARIANT_DENYLIST = [
  'lora',
  'trainer',
  'distilled',
  'gallery',
  'controlnet',
  'multiple-angles',
  'lighting',
  'remove-element',
  'face-to',
  'integrate-product',
  'add-background',
  'inpaint',
  'outpaint',
  'redux',
];

/** Endpoint ids we already use across every registry — never flag these as "new". */
const ADOPTED_IDS = new Set<string>([
  ...Object.values(IMAGE_MODELS).map((m) => m.id),
  ...Object.values(IMAGE_TO_VIDEO_MODELS).map((m) => m.id),
  ...Object.values(AUDIO_MODELS).map((m) => m.id),
]);

/** The modality leaf of an endpoint id (last path segment), or null if none. */
function modalityLeaf(id: string): string | null {
  const last = id.split('/').pop() ?? '';
  return MODALITY_LEAVES.has(last) ? last : null;
}

/** Pull the first numeric version run (e.g. "3", "2.5", "4.6") from a string. */
function extractVersion(id: string): string | null {
  const stripped = id.replace(MODALITY_SUFFIXES, '');
  const match = stripped.match(/v?(\d+(?:\.\d+)*)/i);
  return match?.[1] ?? null;
}

/** Compare dotted numeric versions. Returns >0 if a is newer than b. */
function compareVersions(a: string | null, b: string | null): number {
  const pa = (a ?? '0').split('.').map(Number);
  const pb = (b ?? '0').split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Derive a free-text search keyword (brand) from an endpoint id.
 * e.g. "fal-ai/kling-video/v3/pro/image-to-video" → "kling video"
 *      "fal-ai/nano-banana-2"                      → "nano banana"
 *      "fal-ai/bytedance/seedance/v1.5/pro/…"      → "seedance"
 */
function brandKeyword(id: string): string {
  const parts = id.split('/');
  let i = 0;
  while (i < parts.length - 1 && ORG_PREFIXES.has(parts[i] ?? '')) i++;
  const seg = parts[i] ?? parts[0] ?? id;
  return seg
    .replace(/-?v?\d+(?:\.\d+)*/gi, '') // drop version tokens
    .replace(/-+/g, ' ')
    .trim();
}

/** First alpha token of the brand, used to filter noisy search results. */
function brandStem(id: string): string {
  return brandKeyword(id).split(' ')[0] ?? '';
}

// ---------------------------------------------------------------------------
// Network helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string, timeoutMs = 20_000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'openstory-model-update-checker' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const data: T = await res.json();
    return data;
  } finally {
    clearTimeout(timer);
  }
}

type FalCatalogResponse = {
  items?: { id: string; title?: string; category?: string }[];
};

async function falCatalog(
  keyword: string,
  category: string
): Promise<Candidate[]> {
  const url = `https://fal.ai/api/models?keywords=${encodeURIComponent(
    keyword
  )}&category=${encodeURIComponent(category)}&page=1`;
  const data = await fetchJson<FalCatalogResponse>(url);
  return (data.items ?? []).map((i) => ({
    id: i.id,
    title: i.title,
    version: extractVersion(i.id),
  }));
}

// ---------------------------------------------------------------------------
// fal model checks
// ---------------------------------------------------------------------------

async function checkFalModel(
  source: ModelReport['source'],
  key: string,
  currentId: string,
  category: string
): Promise<ModelReport> {
  const currentVersion = extractVersion(currentId);
  const stem = brandStem(currentId);
  try {
    const results = await falCatalog(brandKeyword(currentId), category);
    // Keep same-brand siblings only (avoid unrelated search noise).
    const family = results
      .filter((c) => brandStem(c.id) === stem && c.id !== currentId)
      .sort((a, b) => compareVersions(b.version, a.version));

    const currentLeaf = modalityLeaf(currentId);
    const newer = family.filter((c) => {
      if (compareVersions(c.version, currentVersion) <= 0) return false;
      if (ADOPTED_IDS.has(c.id)) return false; // already used under another key
      if (VARIANT_DENYLIST.some((token) => c.id.includes(token))) return false;
      // Apples-to-apples: a same-role successor, not a cross-modality sibling.
      if (currentLeaf && modalityLeaf(c.id) !== currentLeaf) return false;
      return true;
    });
    return { source, key, currentId, currentVersion, newer, family };
  } catch (error) {
    return {
      source,
      key,
      currentId,
      currentVersion,
      newer: [],
      family: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ---------------------------------------------------------------------------
// OpenRouter text-model checks
// ---------------------------------------------------------------------------

type OpenRouterResponse = { data?: { id: string; name?: string }[] };

/** Family key = prefix-before-version + suffix-after-version (keeps mini/pro/nano distinct). */
function openRouterFamily(id: string): {
  family: string;
  version: string | null;
} {
  const match = id.match(/^(.*?)(\d+(?:\.\d+)*)(.*)$/);
  if (!match) return { family: id, version: null };
  const prefix = match[1] ?? '';
  const version = match[2] ?? null;
  const suffix = match[3] ?? '';
  return { family: `${prefix}|${suffix}`, version };
}

async function checkTextModels(): Promise<ModelReport[]> {
  let catalog: OpenRouterResponse['data'] = [];
  let fetchError: string | undefined;
  try {
    catalog =
      (
        await fetchJson<OpenRouterResponse>(
          'https://openrouter.ai/api/v1/models'
        )
      ).data ?? [];
  } catch (error) {
    fetchError = error instanceof Error ? error.message : String(error);
  }

  return SCRIPT_ANALYSIS_MODELS.map((model) => {
    const currentVersion = extractVersion(model.id);
    if (fetchError) {
      return {
        source: 'openrouter' as const,
        key: model.name,
        currentId: model.id,
        currentVersion,
        newer: [],
        family: [],
        error: fetchError,
      };
    }
    const { family: ourFamily } = openRouterFamily(model.id);
    const adoptedTextIds = new Set<string>(
      SCRIPT_ANALYSIS_MODELS.map((m) => m.id)
    );
    const siblings = catalog
      .filter((m) => !m.id.startsWith('~')) // skip "latest" aliases
      .filter((m) => !adoptedTextIds.has(m.id)) // already in our registry
      .filter(
        (m) => openRouterFamily(m.id).family === ourFamily && m.id !== model.id
      )
      .map((m) => ({
        id: m.id,
        title: m.name,
        version: openRouterFamily(m.id).version,
      }))
      .sort((a, b) => compareVersions(b.version, a.version));
    const newer = siblings.filter(
      (c) => compareVersions(c.version, currentVersion) > 0
    );
    return {
      source: 'openrouter' as const,
      key: model.name,
      currentId: model.id,
      currentVersion,
      newer,
      family: siblings,
    };
  });
}

// ---------------------------------------------------------------------------
// npm package checks (@tanstack/ai*)
// ---------------------------------------------------------------------------

async function checkPackages(): Promise<PackageReport[]> {
  const pkgPath = join(process.cwd(), 'package.json');
  const pkg: {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  } = JSON.parse(readFileSync(pkgPath, 'utf8'));
  const allDeps: Record<string, string> = {
    ...pkg.dependencies,
    ...pkg.devDependencies,
  };
  const targets = Object.keys(allDeps).filter((name) =>
    name.startsWith('@tanstack/ai')
  );

  return Promise.all(
    targets.map(async (name): Promise<PackageReport> => {
      const range = allDeps[name] ?? '';
      const resolved = range.replace(/^[\^~>=<\s]+/, '');
      try {
        const data = await fetchJson<{ 'dist-tags'?: { latest?: string } }>(
          `https://registry.npmjs.org/${name}`
        );
        const latest = data['dist-tags']?.latest ?? null;
        return {
          source: 'npm',
          name,
          currentRange: range,
          currentResolved: resolved,
          latest,
          isOutdated: latest != null && compareVersions(latest, resolved) > 0,
        };
      } catch (error) {
        return {
          source: 'npm',
          name,
          currentRange: range,
          currentResolved: resolved,
          latest: null,
          isOutdated: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const falChecks: Promise<ModelReport>[] = [
    ...Object.entries(IMAGE_MODELS).map(([key, m]) =>
      checkFalModel('fal-image', key, m.id, 'text-to-image')
    ),
    ...Object.entries(IMAGE_TO_VIDEO_MODELS).map(([key, m]) =>
      checkFalModel('fal-video', key, m.id, 'image-to-video')
    ),
    ...Object.entries(AUDIO_MODELS).map(([key, m]) =>
      checkFalModel('fal-audio', key, m.id, 'text-to-music')
    ),
  ];

  const [falReports, textReports, packageReports] = await Promise.all([
    Promise.all(falChecks),
    checkTextModels(),
    checkPackages(),
  ]);

  const modelReports = [...falReports, ...textReports];
  const modelsWithUpdates = modelReports.filter((r) => r.newer.length > 0);
  const packagesWithUpdates = packageReports.filter((r) => r.isOutdated);
  const hasUpdates =
    modelsWithUpdates.length > 0 || packagesWithUpdates.length > 0;

  if (jsonOutput) {
    console.log(
      JSON.stringify(
        { hasUpdates, models: modelReports, packages: packageReports },
        null,
        2
      )
    );
    return;
  }

  printReport(modelReports, packageReports, hasUpdates);
}

function printReport(
  modelReports: ModelReport[],
  packageReports: PackageReport[],
  hasUpdates: boolean
) {
  const SOURCE_LABEL: Record<ModelReport['source'], string> = {
    'fal-image': 'Image (fal.ai)',
    'fal-video': 'Video / motion (fal.ai)',
    'fal-audio': 'Audio (fal.ai)',
    openrouter: 'Text (OpenRouter)',
  };

  console.log('\n=== Model freshness report ===\n');

  for (const source of [
    'fal-image',
    'fal-video',
    'fal-audio',
    'openrouter',
  ] as const) {
    const group = modelReports.filter((r) => r.source === source);
    console.log(`## ${SOURCE_LABEL[source]}`);
    for (const r of group) {
      if (r.error) {
        console.log(
          `  ⚠️  ${r.key} (${r.currentId}) — lookup failed: ${r.error}`
        );
      } else if (r.newer.length > 0) {
        console.log(
          `  🆕 ${r.key} (${r.currentId}, v${r.currentVersion ?? '?'}) → candidates:`
        );
        for (const c of r.newer) {
          console.log(
            `        ${c.id} (v${c.version ?? '?'})${c.title ? ` — ${c.title}` : ''}`
          );
        }
      } else {
        console.log(`  ✅ ${r.key} (${r.currentId}) — current`);
      }
    }
    console.log('');
  }

  console.log('## Packages (npm)');
  for (const r of packageReports) {
    if (r.error) {
      console.log(`  ⚠️  ${r.name} — lookup failed: ${r.error}`);
    } else if (r.isOutdated) {
      console.log(`  🆕 ${r.name}: ${r.currentResolved} → ${r.latest}`);
    } else {
      console.log(`  ✅ ${r.name}: ${r.currentResolved} (latest ${r.latest})`);
    }
  }

  console.log(
    `\n=== ${hasUpdates ? 'UPDATES AVAILABLE — review candidates above' : 'Everything is up to date'} ===\n`
  );
  console.log(
    'Candidates are heuristic (same brand, higher version number). Verify each\n' +
      'is a genuine successor before bumping — see the update-model-versions skill.\n'
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
