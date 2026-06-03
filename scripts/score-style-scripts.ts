#!/usr/bin/env bun
/**
 * Score the canonical sample SCRIPTS with an LLM (issue #718).
 *
 * The sample-video pipeline gates the generated STILLS (score-image.ts) and the
 * preview THUMBNAILS (score-style-previews.ts), but nothing checks the script
 * itself — and a weak script poisons everything downstream (still → i2v → final
 * mp4) with no later safety net. This scores each style's
 * sample-videos/{slug}/canonical.script.json on the failure modes that actually
 * hurt a sample reel:
 *
 *   - styleAdherence   does the script read as THIS style, or generic cinematic?
 *   - briefCoverage    do the 2-3 beats tell the brief start-to-finish?
 *   - motionFeasibility can each motionPrompt be produced by ONE ~5s image-to-
 *                       video from a SINGLE still? (big cranes / pull-backs that
 *                       reveal geometry not in the frame morph instead of reveal)
 *   - lightingFit      does the lighting match the style's intended look?
 *
 * Flags: per-beat `i2vInfeasible` (hard — forces a re-roll), plus soft advisories
 * `genericGoldenHour` (defaulted to warm/golden when the style isn't warm — the
 * #717 monoculture) and `styleBleed` (a beat names grade/film-stock/medium that
 * the style layer applies separately and must NOT be in the beat).
 *
 * Outputs (report-only — never edits the scripts):
 *   sample-videos/_script-scores.json   full per-script verdicts
 *   console: styles ranked worst-first + a re-roll list + lighting / style-bleed
 *            advisories. Exits non-zero if any style needs a re-roll.
 *
 * Re-roll a flagged style by regenerating its script, then re-scoring:
 *   bun scripts/generate-style-sample-videos.ts --scripts-only --force --filter "<name>"
 *
 * Usage:
 *   bun scripts/score-style-scripts.ts                          # score all
 *   bun scripts/score-style-scripts.ts --filter "Rom Com"
 *   bun scripts/score-style-scripts.ts --model openai/gpt-5.4 --threshold 6.5
 */
import type { TextModel } from '@/lib/ai/models';
import { callLLM } from '@/lib/ai/llm-client';
import {
  ANALYSIS_MODEL_IDS,
  isValidAnalysisModelId,
} from '@/lib/ai/models.config';
import type { StyleConfig } from '@/lib/db/schema/libraries';
import type { ChatMessage } from '@/lib/prompts';
import { styleSlug } from '@/lib/style/style-slug';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

const OUTPUT_DIR = path.join(process.cwd(), 'sample-videos');
const DEFAULT_MODEL = 'google/gemini-3-flash-preview';

function parseArg(name: string): string | undefined {
  const pref = `--${name}=`;
  const eq = process.argv.find((a) => a.startsWith(pref));
  if (eq) return eq.slice(pref.length);
  const idx = process.argv.findIndex((a) => a === `--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}

function resolveModel(): TextModel {
  const m = parseArg('model') ?? DEFAULT_MODEL;
  if (!isValidAnalysisModelId(m)) {
    console.error(
      `Invalid --model "${m}". Options:\n  ${ANALYSIS_MODEL_IDS.join('\n  ')}`
    );
    process.exit(1);
  }
  return m;
}

const MODEL = resolveModel();
const FILTER = parseArg('filter') ?? null;
const THRESHOLD = Number(parseArg('threshold') ?? '6');
const CONCURRENCY = Number(parseArg('concurrency') ?? '6');
const openRouterKey = process.env.OPENROUTER_KEY;
if (!openRouterKey) {
  console.error('OPENROUTER_KEY is required to score scripts.');
  process.exit(1);
}

/** Shape written by generate-style-sample-videos.ts (kept in sync by hand). */
const savedScriptSchema = z.object({
  brief: z.string(),
  enhancedScript: z.string(),
  beats: z
    .array(
      z.object({
        id: z.string(),
        imagePrompt: z.string(),
        motionPrompt: z.string(),
      })
    )
    .min(1),
});
type SavedScript = z.infer<typeof savedScriptSchema>;

const beatVerdictSchema = z.object({
  id: z.string(),
  // hard: the motion can't be produced by a single-still ~5s i2v (reveals new
  // geometry/subjects/locations, big crane/aerial pull-backs, etc.).
  i2vInfeasible: z.boolean().default(false),
  // soft: the beat names a color grade, film stock, or medium/format that the
  // style layer applies separately and must not be baked into the beat.
  styleBleed: z.boolean().default(false),
  note: z.string().default(''),
});
type BeatVerdict = z.infer<typeof beatVerdictSchema>;

const scriptVerdictSchema = z.object({
  styleAdherence: z.number().min(0).max(10),
  briefCoverage: z.number().min(0).max(10),
  motionFeasibility: z.number().min(0).max(10),
  lightingFit: z.number().min(0).max(10),
  // soft: defaulted to golden-hour/warm light when the style's intended lighting
  // is something else (cold, neon, high-key, overcast…). False when warmth IS
  // the look (e.g. award-season, golden cinematic).
  genericGoldenHour: z.boolean().default(false),
  beats: z.array(beatVerdictSchema).default([]),
  note: z.string().default(''),
});
type ScriptVerdict = z.infer<typeof scriptVerdictSchema>;

const SYSTEM_PROMPT = `You are a strict creative director reviewing the SCRIPT for a short (~15s, 2-3 shot) sample video whose only job is to SHOWCASE one specific video style. Each shot is rendered as: a single still image (from imagePrompt) → one continuous ~5 second image-to-video clip (from motionPrompt). The visual style/grade/film-stock is applied SEPARATELY by the style engine and must NOT appear in the prompts.

You are given the style's intended look, the brief, the enhanced script, and the render-ready beats. Judge the BEATS (that is what gets rendered); use the prose only for context.

Return ONLY a JSON object (no markdown, no prose):
{ "styleAdherence": 0-10, "briefCoverage": 0-10, "motionFeasibility": 0-10, "lightingFit": 0-10, "genericGoldenHour": true|false, "beats": [ { "id": "<beat id>", "i2vInfeasible": true|false, "styleBleed": true|false, "note": "<=140 chars" } ], "note": "<=160 chars overall" }

Definitions:
- styleAdherence: do the beats evoke what makes THIS style distinctive (its artStyle/mood/camera), or could they belong to any generic cinematic spot? Generic = low.
- briefCoverage: do the 2-3 beats tell the brief's story start-to-finish (a clear beginning/middle/end), or are they disconnected shots?
- motionFeasibility: can EACH motionPrompt be produced by a single continuous ~5s image-to-video from ONE still? Single-still i2v can do: pushes, slow pans/tilts, handheld drift, rack focus, parallax, subject motion already visible in the frame. It CANNOT honestly: reveal new rooms/geometry/locations, big crane-to-aerial moves, pull back to expose a whole environment, or introduce subjects not in the starting frame — those morph/warp instead. Lower score = more shots demand the impossible.
- lightingFit: does the lighting described in the beats match the style's intended lighting? Penalize a default golden-hour/warm wash on a style meant to look cold/neon/high-key/overcast/clinical.
- genericGoldenHour (soft flag): set true ONLY when the script leans on golden-hour / warm amber / honeyed light AND the style's intended lighting is NOT warm. If warmth genuinely IS the style, set false.
- per beat i2vInfeasible (hard flag): true when THAT beat's motionPrompt demands a move a single-still i2v cannot deliver (see motionFeasibility). When in doubt about a modest move, set false.
- per beat styleBleed (soft flag): true when the beat's imagePrompt/motionPrompt names a color grade, film stock, LUT, or the medium/format (e.g. "Kodak grain", "desaturated grade", "Super 8") — those are applied separately. Describing real lighting/subjects/composition is fine.

Be strict and consistent. One verdict object per beat, in order.`;

function userText(name: string, c: StyleConfig, s: SavedScript): string {
  const beats = s.beats
    .map(
      (b, i) =>
        `BEAT ${i + 1} (id: ${b.id})\n  imagePrompt: ${b.imagePrompt}\n  motionPrompt: ${b.motionPrompt}`
    )
    .join('\n\n');
  return [
    `STYLE: ${name}`,
    '',
    'Intended look:',
    `- Art style: ${c.artStyle}`,
    `- Mood: ${c.mood}`,
    `- Lighting: ${c.lighting}`,
    `- Camera: ${c.cameraWork}`,
    `- Color grading: ${c.colorGrading}`,
    '',
    `Brief: ${s.brief}`,
    '',
    'Enhanced script (context only):',
    s.enhancedScript,
    '',
    `Render-ready beats (${s.beats.length} — judge these):`,
    beats,
  ].join('\n');
}

/** Extract the JSON object from an LLM reply, tolerating ```json fences / prose. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Scorer returned no JSON object');
  }
  return candidate.slice(start, end + 1);
}

function infeasibleBeats(v: ScriptVerdict): BeatVerdict[] {
  return v.beats.filter((b) => b.i2vInfeasible);
}
function bleedBeats(v: ScriptVerdict): BeatVerdict[] {
  return v.beats.filter((b) => b.styleBleed);
}

/**
 * Composite /10: mean of the four scored dimensions, minus penalties for the
 * practical render-killers. An infeasible motion is the worst — it guarantees
 * the clip won't match intent — so it's the heaviest penalty.
 */
function composite(v: ScriptVerdict): number {
  const mean =
    (v.styleAdherence + v.briefCoverage + v.motionFeasibility + v.lightingFit) /
    4;
  const penalty =
    1.5 * infeasibleBeats(v).length +
    1.0 * bleedBeats(v).length +
    (v.genericGoldenHour ? 1.5 : 0);
  return Math.max(0, Math.round((mean - penalty) * 10) / 10);
}

type StyleTask = {
  name: string;
  slug: string;
  config: StyleConfig;
  script: SavedScript;
};
type StyleResult = {
  name: string;
  slug: string;
  verdict: ScriptVerdict;
  composite: number;
};

async function scoreScript(task: StyleTask): Promise<ScriptVerdict> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userText(task.name, task.config, task.script) },
  ];
  const reply = await callLLM({
    model: MODEL,
    messages,
    max_tokens: 1200,
    temperature: 0,
    observationName: 'score-style-script',
    apiKey: openRouterKey,
  });
  return scriptVerdictSchema.parse(JSON.parse(extractJson(reply)));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  // Collect every style that has a canonical.script.json on disk.
  const tasks: StyleTask[] = [];
  const skipped: string[] = [];
  for (const style of DEFAULT_STYLE_TEMPLATES) {
    const slug = styleSlug(style.name);
    if (FILTER && FILTER !== style.name && FILTER !== slug) continue;
    const scriptPath = path.join(OUTPUT_DIR, slug, 'canonical.script.json');
    if (!(await fileExists(scriptPath))) continue;
    const parsed = savedScriptSchema.safeParse(
      JSON.parse(await readFile(scriptPath, 'utf-8'))
    );
    if (!parsed.success) {
      skipped.push(`${slug}: malformed canonical.script.json`);
      continue;
    }
    tasks.push({
      name: style.name,
      slug,
      config: style.config,
      script: parsed.data,
    });
  }

  if (tasks.length === 0) {
    console.error(
      'No canonical.script.json files found. Run generate-style-sample-videos.ts --scripts-only first.'
    );
    process.exit(1);
  }
  console.log(
    `Scoring ${tasks.length} scripts with ${MODEL} (concurrency ${CONCURRENCY})…\n`
  );

  // Concurrency-limited scoring, one call per script.
  const results: StyleResult[] = [];
  const failures: string[] = [];
  let index = 0;
  let done = 0;
  const worker = async () => {
    while (index < tasks.length) {
      const t = tasks[index++];
      if (!t) break;
      try {
        const verdict = await scoreScript(t);
        results.push({
          name: t.name,
          slug: t.slug,
          verdict,
          composite: composite(verdict),
        });
      } catch (error) {
        failures.push(
          `${t.slug}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      done++;
      if (done % 5 === 0 || done === tasks.length) {
        process.stderr.write(`  scored ${done}/${tasks.length} scripts\n`);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker)
  );

  results.sort((a, b) => a.composite - b.composite);

  await writeFile(
    path.join(OUTPUT_DIR, '_script-scores.json'),
    JSON.stringify({ model: MODEL, threshold: THRESHOLD, results }, null, 2)
  );

  // Console report — worst first.
  console.log('\nScript scores (worst first) — composite /10:\n');
  for (const r of results) {
    const v = r.verdict;
    const flags: string[] = [];
    const inf = infeasibleBeats(v).length;
    if (inf > 0) flags.push(`i2v×${inf}`);
    if (v.genericGoldenHour) flags.push('GOLDEN');
    if (bleedBeats(v).length > 0) flags.push('bleed');
    console.log(
      `  ${r.composite.toFixed(1).padStart(4)}  ${r.slug.padEnd(26)} ` +
        `sty=${v.styleAdherence} brief=${v.briefCoverage} mot=${v.motionFeasibility} lit=${v.lightingFit}  ${flags.join(',')}`
    );
  }

  // Re-roll = a hard infeasible-motion beat, or a composite below threshold.
  const reroll = results.filter(
    (r) => r.composite < THRESHOLD || infeasibleBeats(r.verdict).length > 0
  );
  console.log(
    `\n${results.length} scripts scored. ${reroll.length} below threshold ${THRESHOLD} or with an infeasible-motion beat:`
  );
  for (const r of reroll) {
    const bad = infeasibleBeats(r.verdict)
      .map((b) => b.id)
      .join(', ');
    console.log(
      `  - ${r.slug} (${r.composite.toFixed(1)})${bad ? ` — infeasible: ${bad}` : ''}`
    );
  }

  // Soft advisory: golden-hour monoculture (the #717 concern).
  const golden = results.filter((r) => r.verdict.genericGoldenHour);
  console.log(
    `\n${golden.length} script(s) defaulting to golden-hour against their style — review lighting:`
  );
  for (const r of golden) console.log(`  ? ${r.slug}`);

  // Soft advisory: grade/stock/medium leaking into beats.
  const bleed = results.filter((r) => bleedBeats(r.verdict).length > 0);
  if (bleed.length > 0) {
    console.log(`\n${bleed.length} script(s) with style-bleed in a beat:`);
    for (const r of bleed) {
      const ids = bleedBeats(r.verdict)
        .map((b) => b.id)
        .join(', ');
      console.log(`  ? ${r.slug} — ${ids}`);
    }
  }

  if (skipped.length > 0) {
    console.error(`\n${skipped.length} skipped:`);
    for (const s of skipped) console.error(`  - ${s}`);
  }
  if (failures.length > 0) {
    console.error(`\n${failures.length} scripts failed to score:`);
    for (const f of failures) console.error(`  - ${f}`);
  }
  console.log(`\nWrote sample-videos/_script-scores.json`);

  if (reroll.length > 0 || failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
