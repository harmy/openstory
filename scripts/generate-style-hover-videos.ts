/**
 * Generate per-style HOVER videos (#801).
 *
 * For each style this animates the EXACT scene image its tile thumbnail was cut
 * from (see THUMBNAIL_SCENES), so the hover clip matches what the user sees:
 *
 *   1. Motion prompt — generated FROM the still via the production
 *      vision-conditioned path (#929): the
 *      `phase/motion-prompt-scene-generation-chat` template + `motionPromptSchema`,
 *      with the still attached as a vision input on a vision-capable model.
 *      Uses the 512px `{scene}-preview.webp` here — the 2048px originals are
 *      ~5MB, over common vision-API per-image limits (see eval-redo-sequences.ts).
 *   2. Motion generation — image-to-video the FULL-RES `{scene}.webp` (2048px,
 *      some older styles 1024px) with the style's recommended video model.
 *
 * Output: a 5-second, square (1:1), SILENT clip per style, written to
 * `sample-videos/{slug}/hover.mp4` — alongside the existing `canonical.mp4` /
 * `bespoke.mp4`. Upload to R2 with `upload-style-hover-videos-to-r2.ts` (which
 * only ever writes `hover.mp4`, never the canonical/bespoke samples).
 *
 * Reuses production code end to end: the motion-prompt template + schema, the
 * vision-model routing (`resolveVisionModel`/`toVisionImageSource`), the
 * OpenRouter adapter, model-specific prompt assembly (`assembleMotionPrompt`),
 * and the real `submitMotionJob`/`pollMotionJob` motion generation. The only
 * locally-inlined bit is `buildChatMessages` (a copy of the private helper in
 * `llm-call-helper.ts`, which can't be imported here because it pulls in
 * `cloudflare:workers`).
 *
 * Run:
 *   OPENROUTER_KEY=… FAL_KEY=… bun scripts/generate-style-hover-videos.ts [styleNameOrSlug]
 *   (FAL_KEY alone also works — LLM calls route through fal's OpenRouter proxy.)
 *
 * Flags:
 *   [styleNameOrSlug]   Only this style (matched by exact name OR slug).
 *   --concurrency=N     Parallel styles in flight (default 4).
 */

import {
  createAdapter,
  getPlatformLlmKey,
  type LlmKeyInfo,
} from '@/lib/ai/create-adapter';
import { PROMPT_REASONING } from '@/lib/ai/llm-client';
import {
  DEFAULT_VIDEO_MODEL,
  IMAGE_TO_VIDEO_MODELS,
  safeImageToVideoModel,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import {
  analysisModelSupportsVision,
  DEFAULT_ANALYSIS_MODEL,
  getContextWindow,
  resolveVisionModel,
} from '@/lib/ai/models.config';
import {
  motionPromptSchema,
  type MotionPrompt,
} from '@/lib/ai/scene-analysis.schema';
import { assembleMotionPrompt } from '@/lib/motion/assemble-motion-prompt';
import {
  pollMotionJob,
  snapDuration,
  submitMotionJob,
} from '@/lib/motion/motion-generation';
import {
  getChatPrompt,
  type ChatMessage,
  type ChatMessageImagePart,
} from '@/lib/prompts';
import { toVisionImageSource } from '@/lib/storage/external-url';
import { styleSlug } from '@/lib/style/style-slug';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import { chat } from '@tanstack/ai';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Square, silent, 5-second clip — the hover-tile spec. */
const DURATION_SECONDS = 5;
const ASPECT_RATIO = '1:1' as const;
const OUTPUT_DIR = path.join(process.cwd(), 'sample-videos');
const DEFAULT_CONCURRENCY = 4;

/** Poll a motion job no longer than this before giving up on a clip. */
const MOTION_POLL_TIMEOUT_MS = 20 * 60 * 1000;
const MOTION_POLL_INTERVAL_MS = 3_000;

/**
 * Which rendered scene each style's tile thumbnail was cut from — so the hover
 * clip animates the same composition the user sees. This mirrors the per-style
 * `thumbnail-map` that `upload-style-previews-to-r2.ts` used to pick
 * `thumbnail.webp`; the hover sources (`{scene}-preview.webp` for vision,
 * `{scene}.webp` for motion) are the bigger renders of that same scene. Styles
 * absent here fall back to `character`.
 */
const THUMBNAIL_SCENES: Record<string, string> = {
  'low-detail-blockout': 'environment',
  'alcohol-pour': 'context',
  documentary: 'environment',
  'reaction-cam': 'environment',
  'car-talk': 'environment',
  'lo-fi-retro': 'action',
  'intentionally-unfinished': 'character',
  'rough-storyboard': 'environment',
  'podcast-clip': 'action',
  'jewellery-rotation': 'hero',
  'in-context-use': 'context',
  'bedtime-storybook': 'action',
  'travel-destination': 'environment',
  'ugc-unboxing': 'hero',
  'ring-light-tutorial': 'environment',
  'saas-product-demo': 'action',
  'nonprofit-cause': 'environment',
  'chalkboard-doodle': 'action',
  'bathroom-counter-ugc': 'hero',
  'fintech-explainer': 'action',
  'beauty-macro': 'detail',
  'edtech-explainer': 'action',
  claymation: 'action',
  'lo-fi-anime': 'action',
  'as-seen-on-phone': 'hero',
  'restaurant-menu-hero': 'context',
  'luxury-still': 'hero',
  'kitchen-tutorial': 'environment',
  'greyscale-layout': 'action',
  animated: 'environment',
  'street-interview': 'action',
  'automotive-showroom': 'hero',
  'black-white-previz': 'environment',
  'rom-com': 'action',
  corporate: 'environment',
  'perfume-editorial': 'detail',
  'lifestyle-on-model': 'hero',
  'flat-lay-overhead': 'hero',
  'sportswear-motion': 'action',
  'premium-lifestyle': 'action',
  'healthcare-patient-story': 'action',
  'horror-gothic': 'action',
  'watch-macro': 'detail',
  '360-turntable': 'hero',
  'kitchen-counter-ugc': 'hero',
  'automotive-cinematic': 'action',
  'walking-and-talking': 'action',
  'sci-fi-futuristic': 'action',
  'returns-friendly-diagnostic': 'context',
  'gym-selfie-cam': 'environment',
  'mood-only-frames': 'action',
  'felt-and-yarn': 'action',
  'real-estate': 'environment',
  animatic: 'action',
  'marketplace-listing': 'context',
  'neo-noir-thriller': 'action',
  'hospitality-lifestyle': 'environment',
  'warm-vlog': 'environment',
  pastel: 'action',
  action: 'action',
  'food-beverage-hero': 'context',
  'bedroom-confessional': 'environment',
  'fashion-editorial': 'action',
  'fitness-coaching': 'action',
  'product-ad': 'hero',
  'marker-rough': 'environment',
  'tech-keynote': 'action',
  'glossy-product-hero': 'hero',
  'hand-drawn-picture-book': 'action',
  'pop-up-book': 'action',
  'award-season': 'character',
  'western-epic': 'action',
  'schematic-concept': 'action',
  'watercolour-fable': 'action',
  'real-estate-listing': 'environment',
  'b2b-keynote': 'action',
  'saturday-morning-cartoon': 'action',
  'paper-cutout': 'action',
  'packaging-close-up': 'hero',
  'white-background-studio': 'hero',
  // beach-ritual only renders `character` + `action`; its thumbnail uses the
  // upload default scene.
  'beach-ritual': 'character',
};

const DEFAULT_THUMBNAIL_SCENE = 'character';

type StyleTemplate = (typeof DEFAULT_STYLE_TEMPLATES)[number];

/** The scene a style's hover clip animates (its thumbnail's source scene). */
function sceneFor(style: StyleTemplate): string {
  return THUMBNAIL_SCENES[styleSlug(style.name)] ?? DEFAULT_THUMBNAIL_SCENE;
}

/**
 * Swap the `thumbnail.webp` suffix on a style's preview URL for another asset
 * in the same `/styles/{slug}/` folder, keeping whatever assets domain the
 * template baked in.
 */
function previewAsset(style: StyleTemplate, file: string): string {
  if (!style.previewUrl)
    throw new Error(`Style "${style.name}" has no previewUrl`);
  if (!style.previewUrl.endsWith('/thumbnail.webp')) {
    throw new Error(
      `Unexpected previewUrl for "${style.name}": ${style.previewUrl}`
    );
  }
  return style.previewUrl.replace(/thumbnail\.webp$/, file);
}

/** 512px render — small enough for vision-API per-image limits. */
function visionSourceUrl(style: StyleTemplate): string {
  return previewAsset(style, `${sceneFor(style)}-preview.webp`);
}

/** Full-res render (2048px / 1024px) — best fidelity for image-to-video. */
function motionSourceUrl(style: StyleTemplate): string {
  return previewAsset(style, `${sceneFor(style)}.webp`);
}

// ---------------------------------------------------------------------------
// Motion prompt — vision-conditioned on the style's existing preview still.
// ---------------------------------------------------------------------------

/**
 * Flatten chat-prompt messages into `chat()`-ready form and append the vision
 * still to the last user turn. Verbatim copy of the private `buildChatMessages`
 * in `src/lib/workflows/llm-call-helper.ts` — duplicated, not imported, because
 * that module pulls in `cloudflare:workers` (unavailable under Node).
 */
function buildChatMessages(
  messages: ChatMessage[],
  visionImageSources: ChatMessageImagePart['source'][] | undefined
): {
  systemPrompts: string[];
  chatMessages: Array<{
    role: 'user' | 'assistant';
    content: ChatMessage['content'];
  }>;
} {
  const systemPrompts: string[] = [];
  const chatMessages: Array<{
    role: 'user' | 'assistant';
    content: ChatMessage['content'];
  }> = [];
  for (const msg of messages) {
    const flat =
      typeof msg.content === 'string'
        ? msg.content
        : msg.content
            .map((part) => (part.type === 'text' ? part.content : ''))
            .filter(Boolean)
            .join('\n');
    if (msg.role === 'system') {
      systemPrompts.push(flat);
    } else {
      chatMessages.push({ role: msg.role, content: flat });
    }
  }

  if (visionImageSources && visionImageSources.length > 0) {
    const imageParts: ChatMessageImagePart[] = visionImageSources.map(
      (source) => ({ type: 'image', source })
    );
    let lastUserIdx = -1;
    for (let i = chatMessages.length - 1; i >= 0; i--) {
      if (chatMessages[i]?.role === 'user') {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx >= 0) {
      const target = chatMessages[lastUserIdx];
      const text = typeof target?.content === 'string' ? target.content : '';
      chatMessages[lastUserIdx] = {
        role: 'user',
        content: [{ type: 'text', content: text }, ...imageParts],
      };
    } else {
      chatMessages.push({ role: 'user', content: imageParts });
    }
  }

  return { systemPrompts, chatMessages };
}

/**
 * Minimal scene fed to the motion-prompt template. The attached still is the
 * real driver (the template says "animate strictly from the attached frame");
 * this just gives the model a title, a 5s duration target, and no dialogue —
 * so the prompt is a single-shot animation of the preview, not a story beat.
 */
function previewScene(style: StyleTemplate) {
  const slug = styleSlug(style.name);
  return {
    sceneId: `style-hover-${slug}`,
    sceneNumber: 1,
    metadata: {
      title: `${style.name} preview`,
      durationSeconds: DURATION_SECONDS,
      storyBeat: 'A single establishing shot of the preview frame.',
    },
    originalScript: { dialogue: null },
    continuity: { characterTags: [] as string[] },
  };
}

/**
 * Generate the structured motion prompt for a style's preview still, mirroring
 * `durableLLMCallCf`'s non-streaming path: same template, same schema, same
 * vision routing, same reasoning + token budget.
 */
async function generateMotionPrompt(
  style: StyleTemplate,
  visionUrl: string,
  llmKey: LlmKeyInfo
): Promise<MotionPrompt> {
  // Image-bearing call: route a text-only analysis model to DEFAULT_VISION_MODEL.
  const modelId = resolveVisionModel(DEFAULT_ANALYSIS_MODEL, true);
  const adapter = createAdapter(modelId, llmKey);

  const promptVariables = {
    scene: JSON.stringify(previewScene(style), null, 2),
    sceneBefore: '(none)',
    sceneAfter: '(none)',
    characterBible: '(none)',
    styleConfig: JSON.stringify(style.config, null, 2),
    aspectRatio: ASPECT_RATIO,
  };

  const { messages } = await getChatPrompt(
    'phase/motion-prompt-scene-generation-chat',
    promptVariables
  );

  // Attach the still only when the effective model accepts image input.
  const visionImageSources = analysisModelSupportsVision(modelId)
    ? [await toVisionImageSource(visionUrl)]
    : undefined;
  const { systemPrompts, chatMessages } = buildChatMessages(
    messages,
    visionImageSources
  );

  const result = await chat({
    adapter,
    messages: chatMessages,
    systemPrompts,
    stream: false,
    modelOptions: {
      reasoning: PROMPT_REASONING,
      maxCompletionTokens: Math.floor(getContextWindow(modelId) * 0.5),
    },
    outputSchema: motionPromptSchema,
    debug: false,
  });

  return motionPromptSchema.parse(result);
}

// ---------------------------------------------------------------------------
// Motion generation — image-to-video the preview still, silent + 5s + square.
// ---------------------------------------------------------------------------

async function generateClip(
  motionUrl: string,
  prompt: string,
  model: ImageToVideoModel
): Promise<string> {
  const job = await submitMotionJob({
    imageUrl: motionUrl,
    prompt,
    model,
    duration: DURATION_SECONDS,
    aspectRatio: ASPECT_RATIO,
    // Square output: Seedance honours aspectRatio; Grok has no aspect_ratio
    // param and inherits the (square) input still — the renders are square.
    generateAudio: false, // silent — no sound on hover clips
  });

  const deadline = Date.now() + MOTION_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const poll = await pollMotionJob(job.jobId, job.modelKey);
    if (poll.status === 'completed') {
      if (poll.url) return poll.url;
      throw new Error(poll.error || 'Completed with no video URL');
    }
    if (poll.status === 'failed') {
      throw new Error(poll.error || 'Motion generation failed');
    }
    await new Promise((r) => setTimeout(r, MOTION_POLL_INTERVAL_MS));
  }
  throw new Error(
    `Timed out after ${MOTION_POLL_TIMEOUT_MS / 60_000} minutes waiting for clip`
  );
}

async function downloadVideo(url: string, outputPath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download clip (${response.status}): ${url}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  await writeFile(outputPath, Buffer.from(bytes));
}

/** HEAD-check an asset so a missing render fails fast with a clear message. */
async function assertAssetExists(url: string, label: string): Promise<void> {
  const res = await fetch(url, { method: 'HEAD' });
  if (!res.ok) {
    throw new Error(`${label} not found (${res.status}): ${url}`);
  }
}

// ---------------------------------------------------------------------------
// Per-style pipeline + concurrency runner.
// ---------------------------------------------------------------------------

async function processStyle(
  style: StyleTemplate,
  llmKey: LlmKeyInfo
): Promise<void> {
  const slug = styleSlug(style.name);
  const scene = sceneFor(style);
  const visionUrl = visionSourceUrl(style);
  const motionUrl = motionSourceUrl(style);

  const model = safeImageToVideoModel(
    style.recommendedVideoModel,
    DEFAULT_VIDEO_MODEL
  );
  const snappedDuration = snapDuration(DURATION_SECONDS, model);

  console.log(
    `🎬 ${style.name} — scene "${scene}", model ${IMAGE_TO_VIDEO_MODELS[model].name} (${snappedDuration}s, ${ASPECT_RATIO})`
  );

  // Fail fast if the full-res render is missing for this style/scene.
  await assertAssetExists(motionUrl, `Motion source (${scene}.webp)`);

  const motionPrompt = await generateMotionPrompt(style, visionUrl, llmKey);
  const assembled = assembleMotionPrompt({
    motionPrompt,
    model,
    characterTags: [],
  });

  const clipUrl = await generateClip(motionUrl, assembled, model);

  const styleDir = path.join(OUTPUT_DIR, slug);
  await mkdir(styleDir, { recursive: true });
  const outputPath = path.join(styleDir, 'hover.mp4');
  await downloadVideo(clipUrl, outputPath);

  console.log(`✅ ${style.name} → ${path.relative(process.cwd(), outputPath)}`);
}

/** Run `worker` over `items` with at most `limit` in flight at once. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<{ failures: Array<{ item: T; error: unknown }> }> {
  const failures: Array<{ item: T; error: unknown }> = [];
  let cursor = 0;

  async function runNext(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor++;
      const item = items[index];
      if (item === undefined) continue;
      try {
        await worker(item);
      } catch (error) {
        failures.push({ item, error });
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, runNext)
  );
  return { failures };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const filter = args.find((a) => !a.startsWith('--'))?.trim() ?? null;
  const concurrency = Number(
    args.find((a) => a.startsWith('--concurrency='))?.split('=')[1] ??
      DEFAULT_CONCURRENCY
  );

  const llmKey = getPlatformLlmKey();
  if (!llmKey) {
    console.error(
      '❌ No LLM key. Set OPENROUTER_KEY (or FAL_KEY to route via fal).'
    );
    process.exit(1);
  }

  let styles = DEFAULT_STYLE_TEMPLATES;
  if (filter) {
    styles = styles.filter(
      (s) => s.name === filter || styleSlug(s.name) === filter
    );
    if (styles.length === 0) {
      console.error(`❌ No style matches "${filter}".`);
      process.exit(1);
    }
  }

  console.log(
    `🎨 Generating ${DURATION_SECONDS}s ${ASPECT_RATIO} silent hover clips for ${styles.length} style(s) — concurrency ${concurrency}\n`
  );

  await mkdir(OUTPUT_DIR, { recursive: true });

  const { failures } = await mapWithConcurrency(
    [...styles],
    concurrency,
    (style) => processStyle(style, llmKey)
  );

  console.log(
    `\n✨ Done: ${styles.length - failures.length}/${styles.length} clips generated.`
  );
  if (failures.length > 0) {
    console.error(`\n❌ ${failures.length} failed:`);
    for (const { item, error } of failures) {
      console.error(
        `   - ${item.name}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
