/**
 * Generate style sample videos (issue #718).
 *
 * CANONICAL sample (every style): a per-category one-liner brief is run through
 * the app's script-enhancer (`getPrompt('script/enhance')` + the same
 * createUserPrompt path the UI uses) and split into 2-3 render-ready beats, so
 * each style gets a style-appropriate ~15s script. BESPOKE sample (~10 hero
 * styles): a curated script from BESPOKE_SCRIPTS. Each beat is: still
 * (recommended image model) → image-to-video (recommended video model) → the
 * clips are concatenated into one mp4 via the system `ffmpeg`.
 *
 * Output (local, for review before upload):
 *   sample-videos/{slug}/canonical.mp4
 *   sample-videos/{slug}/bespoke.mp4              (hero styles only)
 *   sample-videos/{slug}/canonical.script.json    (enhanced script + beats, reviewable + reused)
 *   sample-videos/{slug}/_frames/*.webp|.mp4      (intermediate stills + clips)
 *
 * Two-phase workflow:
 *   1. --scripts-only  → just enhance + split + save canonical.script.json (needs OPENROUTER_KEY).
 *      Review the scripts, then…
 *   2. (default)       → render. Reuses any saved script.json; --force regenerates.
 *
 * Without FAL_KEY, the default run is a dry-run (prints resolved models + brief
 * + estimated fal.ai spend so you see the bill first).
 *
 * Still gate: when OPENROUTER_KEY is set, each generated still is scored and
 * re-rolled (up to STILL_ATTEMPTS, default 3) on a clear failure — literal
 * medium, multi-frame, or gross anatomy — BEFORE the expensive image-to-video
 * step, since a sample video has no later pick-the-best safety net. Disable with
 * --no-gate.
 *
 * Usage:
 *   bun scripts/generate-style-sample-videos.ts --scripts-only            # phase 1 (LLM only)
 *   FAL_KEY=… bun scripts/generate-style-sample-videos.ts --filter "Product Ad"
 *   FAL_KEY=… bun scripts/generate-style-sample-videos.ts                 # all styles
 *   bun scripts/generate-style-sample-videos.ts --dry-run                 # cost preview
 *   …--canonical-only | --bespoke-only | --hero-only | --force | --no-gate
 */
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  safeImageToVideoModel,
  safeTextToImageModel,
  type ImageToVideoModel,
  type TextModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import { microsToUsd } from '@/lib/billing/money';
import {
  aspectRatioSchema,
  aspectRatioToImageSize,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import type { StyleConfig } from '@/lib/db/schema/libraries';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import {
  calculateMotionMetadata,
  pollMotionJob,
  submitMotionJob,
} from '@/lib/motion/motion-generation';
import { generateCanonicalScript } from '@/lib/style/sample-script';
import {
  scoreStill,
  stillFlagLabels,
  stillRejected,
} from '@/lib/style/score-image';
import { buildStyledImagePrompt } from '@/lib/style/style-image-prompt';
import {
  BESPOKE_SCRIPTS,
  briefForStyle,
  NOMINAL_BEAT_SECONDS,
  type SampleBeat,
} from '@/lib/style/sample-videos';
import { styleSlug } from '@/lib/style/style-slug';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import { PhotonImage } from '@cf-wasm/photon';
import { execFile } from 'node:child_process';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const OUTPUT_DIR = path.join(process.cwd(), 'sample-videos');
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? '3'); // script-gen (LLM) pool; render uses the submit throttle below
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * fal has its own queue, so the render path doesn't cap concurrency — it meters
 * the SUBMISSION rate. Every fal submit (image gen + image-to-video) waits its
 * turn via throttleSubmit() so no two fire within SUBMIT_INTERVAL_MS of each
 * other; fal queues everything behind them. Jobs are launched all at once and
 * poll their own results — the throttle is the only rate limit.
 */
const SUBMIT_INTERVAL_MS = Number(process.env.SUBMIT_INTERVAL_MS ?? '1000');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let nextSubmitAt = 0;
async function throttleSubmit(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSubmitAt - now);
  nextSubmitAt = Math.max(now, nextSubmitAt) + SUBMIT_INTERVAL_MS;
  if (wait > 0) await sleep(wait);
}
/** Upper bound of the enhancer's 2-3 scene range — used for cost estimates. */
const CANONICAL_PLANNED_SCENES = 3;

// Still-quality gate: score each generated still and re-roll bad ones BEFORE
// the expensive image-to-video step (videos have no later pick-the-best safety
// net like thumbnails do). Disabled with --no-gate or when OPENROUTER_KEY is
// absent. The gate model just needs to be vision-capable + cheap.
const OPENROUTER_KEY = process.env.OPENROUTER_KEY;
const STILL_ATTEMPTS = Number(process.env.STILL_ATTEMPTS ?? '3');
const GATE_MODEL: TextModel = 'google/gemini-3-flash-preview';
const gateEnabled = !process.argv.includes('--no-gate') && !!OPENROUTER_KEY;

const hasFalKey = !!process.env.FAL_KEY;

type Flags = {
  filter: string | null;
  canonicalOnly: boolean;
  bespokeOnly: boolean;
  heroOnly: boolean;
  force: boolean;
  scriptsOnly: boolean;
  dryRun: boolean;
};

function parseFlags(argv: string[]): Flags {
  const filterIdx = argv.findIndex((a) => a === '--filter');
  return {
    filter: filterIdx >= 0 ? (argv[filterIdx + 1]?.trim() ?? null) : null,
    canonicalOnly: argv.includes('--canonical-only'),
    bespokeOnly: argv.includes('--bespoke-only'),
    heroOnly: argv.includes('--hero-only'),
    force: argv.includes('--force'),
    scriptsOnly: argv.includes('--scripts-only'),
    dryRun: argv.includes('--dry-run') || !hasFalKey,
  };
}

type RenderJob = {
  styleName: string;
  slug: string;
  kind: 'canonical' | 'bespoke';
  imageModel: TextToImageModel;
  videoModel: ImageToVideoModel;
  aspectRatio: AspectRatio;
  config: StyleConfig;
  outputPath: string;
  force: boolean;
  /** Canonical only: enhanced from this per-category brief. */
  brief?: string;
  /** Bespoke only: curated beats (skip enhance). */
  curatedBeats?: SampleBeat[];
  /** Scene count used for cost estimates before enhance resolves real beats. */
  plannedScenes: number;
};

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

function buildJobs(flags: Flags): RenderJob[] {
  const jobs: RenderJob[] = [];
  for (const style of DEFAULT_STYLE_TEMPLATES) {
    const slug = styleSlug(style.name);
    if (flags.filter && flags.filter !== style.name && flags.filter !== slug) {
      continue;
    }
    const bespoke = BESPOKE_SCRIPTS[slug];
    if (flags.heroOnly && !bespoke) continue;

    const imageModel = safeTextToImageModel(
      style.recommendedImageModel,
      DEFAULT_IMAGE_MODEL
    );
    const videoModel = safeImageToVideoModel(style.recommendedVideoModel);
    const aspectRatio = aspectRatioSchema
      .catch('16:9')
      .parse(style.defaultAspectRatio ?? '16:9');
    const styleDir = path.join(OUTPUT_DIR, slug);

    const common = {
      styleName: style.name,
      slug,
      imageModel,
      videoModel,
      aspectRatio,
      config: style.config,
      force: flags.force,
    };

    if (!flags.bespokeOnly) {
      jobs.push({
        ...common,
        kind: 'canonical',
        brief: briefForStyle(style),
        plannedScenes: CANONICAL_PLANNED_SCENES,
        outputPath: path.join(styleDir, 'canonical.mp4'),
      });
    }
    if (bespoke && !flags.canonicalOnly) {
      jobs.push({
        ...common,
        kind: 'bespoke',
        curatedBeats: bespoke,
        plannedScenes: bespoke.length,
        outputPath: path.join(styleDir, 'bespoke.mp4'),
      });
    }
  }
  return jobs;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function scriptJsonPath(job: RenderJob): string {
  return path.join(path.dirname(job.outputPath), `${job.kind}.script.json`);
}

/**
 * Resolve a job's beats. Bespoke → curated. Canonical → reuse the saved
 * script.json (unless --force), else enhance the brief + split into beats and
 * persist it for review/reproducibility.
 */
async function prepareBeats(job: RenderJob): Promise<SampleBeat[]> {
  if (job.curatedBeats) return job.curatedBeats;
  if (!job.brief) throw new Error(`Canonical job ${job.slug} has no brief`);

  const scriptPath = scriptJsonPath(job);
  if (!job.force && (await fileExists(scriptPath))) {
    const saved = savedScriptSchema.safeParse(
      JSON.parse(await readFile(scriptPath, 'utf-8'))
    );
    if (saved.success) return saved.data.beats;
  }

  const { enhancedScript, beats } = await generateCanonicalScript({
    brief: job.brief,
    styleConfig: job.config,
    aspectRatio: job.aspectRatio,
  });
  const saved: SavedScript = { brief: job.brief, enhancedScript, beats };
  await mkdir(path.dirname(scriptPath), { recursive: true });
  await writeFile(scriptPath, JSON.stringify(saved, null, 2));
  return beats;
}

/** Re-encode downloaded image bytes to a webp (for review) + a base64 JPEG (for scoring). */
function encodeStill(bytes: Uint8Array): { webp: Buffer; jpegBase64: string } {
  const image = PhotonImage.new_from_byteslice(bytes);
  try {
    return {
      webp: Buffer.from(image.get_bytes_webp()),
      jpegBase64: Buffer.from(image.get_bytes_jpeg(85)).toString('base64'),
    };
  } finally {
    image.free();
  }
}

async function generateStillOnce(
  job: RenderJob,
  beat: SampleBeat
): Promise<{ url: string; bytes: Uint8Array }> {
  await throttleSubmit();
  const result = await generateImageWithProvider({
    model: job.imageModel,
    prompt: buildStyledImagePrompt(beat.imagePrompt, job.config),
    imageSize: aspectRatioToImageSize(job.aspectRatio),
    numImages: 1,
    resolution: '2K',
  });
  const url = result.imageUrls[0];
  if (!url) throw new Error(`No image returned for ${job.slug}/${beat.id}`);
  const res = await fetch(url);
  return { url, bytes: new Uint8Array(await res.arrayBuffer()) };
}

/**
 * Generate a still for one beat, write it locally as webp, return its URL. When
 * the gate is enabled, score each still and re-roll on a clear failure
 * (literal-medium / multi-frame / gross anatomy) up to STILL_ATTEMPTS, keeping
 * the first clean one (or the best-scoring if none come back clean) — so we
 * never animate a known-bad frame.
 */
async function renderStill(
  job: RenderJob,
  beat: SampleBeat,
  framesDir: string
): Promise<string> {
  const webpPath = path.join(framesDir, `${beat.id}.webp`);

  if (!gateEnabled || !OPENROUTER_KEY) {
    const { url, bytes } = await generateStillOnce(job, beat);
    await writeFile(webpPath, encodeStill(bytes).webp);
    return url;
  }

  let best: { url: string; webp: Buffer; adherence: number } | null = null;
  for (let attempt = 1; attempt <= STILL_ATTEMPTS; attempt++) {
    const { url, bytes } = await generateStillOnce(job, beat);
    const { webp, jpegBase64 } = encodeStill(bytes);
    const verdict = await scoreStill({
      jpegBase64,
      styleName: job.styleName,
      sceneDescription: beat.imagePrompt,
      config: job.config,
      model: GATE_MODEL,
      apiKey: OPENROUTER_KEY,
    });
    if (!best || verdict.styleAdherence > best.adherence) {
      best = { url, webp, adherence: verdict.styleAdherence };
    }
    if (!stillRejected(verdict)) {
      await writeFile(webpPath, webp);
      return url;
    }
    console.log(
      `   ↻ ${job.slug}/${beat.id} still re-roll ${attempt}/${STILL_ATTEMPTS} [${stillFlagLabels(verdict)}]`
    );
  }
  // No clean still after all attempts — use the best one and warn.
  if (!best) throw new Error(`No still produced for ${job.slug}/${beat.id}`);
  console.warn(
    `   ⚠️  ${job.slug}/${beat.id}: kept best-of-${STILL_ATTEMPTS} still (still flagged)`
  );
  await writeFile(webpPath, best.webp);
  return best.url;
}

/** Submit + poll one i2v clip; download it locally; return the local path. */
async function renderClip(
  job: RenderJob,
  beat: SampleBeat,
  imageUrl: string,
  framesDir: string
): Promise<string> {
  await throttleSubmit();
  const submission = await submitMotionJob({
    imageUrl,
    prompt: beat.motionPrompt,
    model: job.videoModel,
    duration: NOMINAL_BEAT_SECONDS,
    aspectRatio: job.aspectRatio,
    generateAudio: false, // silent for clean apples-to-apples comparison
  });

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const poll = await pollMotionJob(submission.jobId, submission.modelKey);
    if (poll.status === 'completed') {
      if (!poll.url)
        throw new Error(`Clip completed without URL: ${job.slug}/${beat.id}`);
      const res = await fetch(poll.url);
      const clipPath = path.join(framesDir, `${beat.id}.mp4`);
      await writeFile(clipPath, Buffer.from(await res.arrayBuffer()));
      return clipPath;
    }
    if (poll.status === 'failed') {
      throw new Error(
        `Motion failed for ${job.slug}/${beat.id}: ${poll.error ?? 'unknown'}`
      );
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`Motion timed out for ${job.slug}/${beat.id}`);
}

/** Concatenate clips into one mp4. Stream-copy first, re-encode on failure. */
async function concatClips(clipPaths: string[], outputPath: string) {
  const listFile = path.join(
    path.dirname(clipPaths[0] ?? outputPath),
    'concat.txt'
  );
  const list = clipPaths
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  await writeFile(listFile, list);
  try {
    await execFileAsync('ffmpeg', [
      '-y',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listFile,
      '-c',
      'copy',
      outputPath,
    ]);
  } catch {
    // Codec/params differ across clips — re-encode through the concat filter.
    const inputs = clipPaths.flatMap((p) => ['-i', p]);
    const filter =
      clipPaths.map((_, i) => `[${i}:v:0]`).join('') +
      `concat=n=${clipPaths.length}:v=1:a=0[outv]`;
    await execFileAsync('ffmpeg', [
      '-y',
      ...inputs,
      '-filter_complex',
      filter,
      '-map',
      '[outv]',
      outputPath,
    ]);
  }
}

async function renderJob(job: RenderJob): Promise<void> {
  if (!job.force && (await fileExists(job.outputPath))) {
    console.log(`⏭️  ${job.slug}/${job.kind} exists — skipping (use --force)`);
    return;
  }
  const beats = await prepareBeats(job);
  const framesDir = path.join(
    path.dirname(job.outputPath),
    '_frames',
    job.kind
  );
  await mkdir(framesDir, { recursive: true });

  // 1. Stills (parallel across beats — shared subject text keeps them consistent).
  const stills = await Promise.all(
    beats.map(async (beat) => ({
      beat,
      imageUrl: await renderStill(job, beat, framesDir),
    }))
  );
  // 2. Clips (parallel submit + poll), preserving beat order.
  const clipPaths = await Promise.all(
    stills.map(({ beat, imageUrl }) =>
      renderClip(job, beat, imageUrl, framesDir)
    )
  );
  // 3. Concatenate.
  await mkdir(path.dirname(job.outputPath), { recursive: true });
  await concatClips(clipPaths, job.outputPath);
  await rm(path.join(framesDir, 'concat.txt'), { force: true });
  console.log(
    `✅ ${job.slug}/${job.kind} → ${path.relative(process.cwd(), job.outputPath)}`
  );
}

/** Estimate total fal.ai video cost (excludes image cost; canonical uses planned scene count). */
function estimateCost(jobs: RenderJob[]): number {
  let usd = 0;
  for (const job of jobs) {
    const { cost } = calculateMotionMetadata({
      imageUrl: 'https://example.com/x.webp',
      prompt: 'sample',
      model: job.videoModel,
      duration: NOMINAL_BEAT_SECONDS,
      aspectRatio: job.aspectRatio,
      generateAudio: false,
    });
    usd += microsToUsd(cost) * job.plannedScenes;
  }
  return usd;
}

function printDryRun(jobs: RenderJob[]) {
  console.log('🔍 Dry run — no generation. Resolved plan:\n');
  const byStyle = new Map<string, RenderJob[]>();
  for (const job of jobs) {
    byStyle.set(job.slug, [...(byStyle.get(job.slug) ?? []), job]);
  }
  for (const [slug, styleJobs] of byStyle) {
    const first = styleJobs[0];
    if (!first) continue;
    console.log(
      `• ${first.styleName} (${slug}) — image:${IMAGE_MODELS[first.imageModel].name}, ` +
        `video:${IMAGE_TO_VIDEO_MODELS[first.videoModel].name}, ${first.aspectRatio}`
    );
    for (const job of styleJobs) {
      const detail =
        job.kind === 'canonical'
          ? `brief: "${job.brief}" → ~${job.plannedScenes} scenes`
          : `${job.plannedScenes} curated beats`;
      console.log(`    ${job.kind}: ${detail} × ${NOMINAL_BEAT_SECONDS}s`);
    }
  }
  const clips = jobs.reduce((n, j) => n + j.plannedScenes, 0);
  console.log(
    `\nTotals: ${byStyle.size} styles, ${jobs.length} videos, ~${clips} clips ` +
      `(+~${clips} image gens). Est. video spend ≈ $${estimateCost(jobs).toFixed(2)} ` +
      `(image + LLM script cost not included).`
  );
  if (!hasFalKey)
    console.log('\n(FAL_KEY not set — set it to actually render.)');
}

/** Phase 1: enhance + split + save canonical.script.json (no rendering). */
async function runScriptsOnly(jobs: RenderJob[]) {
  const canonical = jobs.filter((j) => j.kind === 'canonical');
  console.log(
    `✍️  Generating ${canonical.length} canonical scripts (no render)…\n`
  );
  let index = 0;
  const failures: string[] = [];
  const worker = async () => {
    while (index < canonical.length) {
      const job = canonical[index++];
      if (!job) break;
      try {
        const beats = await prepareBeats(job);
        console.log(
          `✅ ${job.slug}: ${beats.length} beats → ${path.relative(process.cwd(), scriptJsonPath(job))}`
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`❌ ${job.slug}: ${message}`);
        failures.push(job.slug);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, canonical.length) }, worker)
  );
  console.log(
    `\nDone: ${canonical.length - failures.length}/${canonical.length} scripts.`
  );
  if (failures.length > 0) process.exit(1);
}

/**
 * Launch every job at once and let each one submit + poll independently;
 * throttleSubmit() meters the actual fal submission rate (1 per
 * SUBMIT_INTERVAL_MS) and fal's queue absorbs the backlog, so there's no fixed
 * concurrency cap. Failures are collected without aborting the rest.
 */
async function runPool(jobs: RenderJob[]) {
  const failures: { slug: string; kind: string; error: string }[] = [];
  await Promise.all(
    jobs.map(async (job) => {
      try {
        await renderJob(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`❌ ${job.slug}/${job.kind}: ${message}`);
        failures.push({ slug: job.slug, kind: job.kind, error: message });
      }
    })
  );
  return failures;
}

async function main() {
  const flags = parseFlags(process.argv.slice(2));
  const jobs = buildJobs(flags);

  if (jobs.length === 0) {
    console.error('No matching styles. Check --filter / flags.');
    process.exit(1);
  }

  if (flags.scriptsOnly) {
    await runScriptsOnly(jobs);
    return;
  }

  if (flags.dryRun) {
    printDryRun(jobs);
    return;
  }

  console.log(
    `🎬 Rendering ${jobs.length} videos (submitting 1 fal job every ${SUBMIT_INTERVAL_MS}ms; fal queues the rest). Est. spend ≈ $${estimateCost(jobs).toFixed(2)}\n`
  );
  await mkdir(OUTPUT_DIR, { recursive: true });
  const failures = await runPool(jobs);

  console.log(
    `\nDone: ${jobs.length - failures.length}/${jobs.length} succeeded.`
  );
  if (failures.length > 0) {
    console.error(`${failures.length} failed:`);
    for (const f of failures)
      console.error(`   - ${f.slug}/${f.kind}: ${f.error}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
