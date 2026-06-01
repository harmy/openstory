/**
 * Generate style sample videos (issue #718).
 *
 * For each style template, renders a 15s CANONICAL sample from one fixed 3-beat
 * script (apples-to-apples across the catalogue). The ~10 hero styles also get
 * a BESPOKE sample from their curated script. Each beat is: generate a still
 * (recommended image model) → image-to-video (recommended video model) → the
 * clips are concatenated into one mp4 via the system `ffmpeg`.
 *
 * Output (local, for review before upload):
 *   sample-videos/{slug}/canonical.mp4
 *   sample-videos/{slug}/bespoke.mp4          (hero styles only)
 *   sample-videos/{slug}/_frames/*.webp/.mp4  (intermediate stills + clips)
 *
 * Without FAL_KEY this runs as a dry-run: prints resolved models, prompts, and
 * an estimated fal.ai cost so you can see the bill before committing.
 *
 * Usage:
 *   FAL_KEY=… bun scripts/generate-style-sample-videos.ts                 # all styles
 *   FAL_KEY=… bun scripts/generate-style-sample-videos.ts --filter "Product Ad"
 *   bun scripts/generate-style-sample-videos.ts --dry-run                 # cost preview
 *   …--canonical-only | --bespoke-only | --hero-only | --force
 */
import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  safeImageToVideoModel,
  safeTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import { microsToUsd } from '@/lib/billing/money';
import {
  aspectRatioSchema,
  aspectRatioToImageSize,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import {
  calculateMotionMetadata,
  pollMotionJob,
  submitMotionJob,
} from '@/lib/motion/motion-generation';
import {
  BESPOKE_SCRIPTS,
  CANONICAL_SAMPLE_SCRIPT,
  NOMINAL_BEAT_SECONDS,
  type SampleBeat,
} from '@/lib/style/sample-videos';
import { styleSlug } from '@/lib/style/style-slug';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import type { StyleConfig } from '@/lib/db/schema/libraries';
import { PhotonImage } from '@cf-wasm/photon';
import { execFile } from 'node:child_process';
import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const OUTPUT_DIR = path.join(process.cwd(), 'sample-videos');
const MAX_CONCURRENT = Number(process.env.MAX_CONCURRENT ?? '3'); // videos are heavy
const POLL_INTERVAL_MS = 5000;
const POLL_TIMEOUT_MS = 15 * 60 * 1000;

const hasFalKey = !!process.env.FAL_KEY;

type Flags = {
  filter: string | null;
  canonicalOnly: boolean;
  bespokeOnly: boolean;
  heroOnly: boolean;
  force: boolean;
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
    dryRun: argv.includes('--dry-run') || !hasFalKey,
  };
}

type RenderJob = {
  styleName: string;
  slug: string;
  kind: 'canonical' | 'bespoke';
  beats: SampleBeat[];
  imageModel: TextToImageModel;
  videoModel: ImageToVideoModel;
  aspectRatio: AspectRatio;
  config: StyleConfig;
  outputPath: string;
  force: boolean;
};

const NEGATIVE =
  'No text, no words, no titles, no watermarks, no logos. No celebrities, no famous people, no real identifiable individuals. No grid, no collage, no split screen. Single continuous shot only';

/** Blend the style config into a beat's image prompt (mirrors previews script). */
function buildImagePrompt(beat: SampleBeat, config: StyleConfig): string {
  return [
    beat.imagePrompt,
    `Art Style: ${config.artStyle}`,
    `Mood: ${config.mood}`,
    `Lighting: ${config.lighting}`,
    `Camera: ${config.cameraWork}`,
    `Color Grading: ${config.colorGrading}`,
    config.referenceFilms.length
      ? `Inspired by: ${config.referenceFilms.join(', ')}`
      : '',
    NEGATIVE,
  ]
    .filter(Boolean)
    .join('. ');
}

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
        beats: CANONICAL_SAMPLE_SCRIPT,
        outputPath: path.join(styleDir, 'canonical.mp4'),
      });
    }
    if (bespoke && !flags.canonicalOnly) {
      jobs.push({
        ...common,
        kind: 'bespoke',
        beats: bespoke,
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

/** Generate a still for one beat and write it locally as webp; return its URL. */
async function renderStill(
  job: RenderJob,
  beat: SampleBeat,
  framesDir: string
): Promise<string> {
  const result = await generateImageWithProvider({
    model: job.imageModel,
    prompt: buildImagePrompt(beat, job.config),
    imageSize: aspectRatioToImageSize(job.aspectRatio),
    numImages: 1,
    resolution: '2K',
  });
  const url = result.imageUrls[0];
  if (!url) throw new Error(`No image returned for ${job.slug}/${beat.id}`);

  // Save a local webp copy for review.
  const res = await fetch(url);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const image = PhotonImage.new_from_byteslice(bytes);
  try {
    await writeFile(
      path.join(framesDir, `${beat.id}.webp`),
      Buffer.from(image.get_bytes_webp())
    );
  } finally {
    image.free();
  }
  return url;
}

/** Submit + poll one i2v clip; download it locally; return the local path. */
async function renderClip(
  job: RenderJob,
  beat: SampleBeat,
  imageUrl: string,
  framesDir: string
): Promise<string> {
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
  const framesDir = path.join(
    path.dirname(job.outputPath),
    '_frames',
    job.kind
  );
  await mkdir(framesDir, { recursive: true });

  // 1. Stills (parallel across beats — shared subject text keeps them consistent).
  const stills = await Promise.all(
    job.beats.map(async (beat) => ({
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

/** Estimate total fal.ai video cost for a set of jobs (excludes image cost). */
function estimateCost(jobs: RenderJob[]): number {
  let usd = 0;
  for (const job of jobs) {
    for (const beat of job.beats) {
      const { cost } = calculateMotionMetadata({
        imageUrl: 'https://example.com/x.webp',
        prompt: beat.motionPrompt,
        model: job.videoModel,
        duration: NOMINAL_BEAT_SECONDS,
        aspectRatio: job.aspectRatio,
        generateAudio: false,
      });
      usd += microsToUsd(cost);
    }
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
      console.log(
        `    ${job.kind}: ${job.beats.length} beats × ${NOMINAL_BEAT_SECONDS}s`
      );
    }
  }
  const clips = jobs.reduce((n, j) => n + j.beats.length, 0);
  console.log(
    `\nTotals: ${byStyle.size} styles, ${jobs.length} videos, ${clips} clips ` +
      `(+${clips} image gens). Est. video spend ≈ $${estimateCost(jobs).toFixed(2)} ` +
      `(image gen cost not included).`
  );
  if (!hasFalKey)
    console.log('\n(FAL_KEY not set — set it to actually render.)');
}

/** Run jobs with a fixed concurrency, collecting failures without aborting. */
async function runPool(jobs: RenderJob[]) {
  let index = 0;
  const failures: { slug: string; kind: string; error: string }[] = [];
  const worker = async () => {
    while (index < jobs.length) {
      const job = jobs[index++];
      if (!job) break;
      try {
        await renderJob(job);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`❌ ${job.slug}/${job.kind}: ${message}`);
        failures.push({ slug: job.slug, kind: job.kind, error: message });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(MAX_CONCURRENT, jobs.length) }, worker)
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

  if (flags.dryRun) {
    printDryRun(jobs);
    return;
  }

  console.log(
    `🎬 Rendering ${jobs.length} videos (${MAX_CONCURRENT} concurrent). Est. spend ≈ $${estimateCost(jobs).toFixed(2)}\n`
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
