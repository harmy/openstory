/**
 * Canonical sample-script generation (issue #718).
 *
 * Mirrors the app's real "enhance" path headlessly:
 *   1. `getPrompt('script/enhance')` (Langfuse, or the bundled local fallback)
 *      + `createUserPrompt(brief, { styleConfig, aspectRatio, targetDuration })`
 *      → the same style-aware enhance the UI uses (`enhanceScriptStreamFn`).
 *   2. A structured scene split turns the enhanced prose into render-ready beats.
 *
 * Kept out of `sample-videos.ts` (pure data) because it pulls in the LLM client.
 * Only the render script imports this; the seed + unit tests stay light.
 */
import { getEnv } from '#env';
import { callLLM, RECOMMENDED_MODELS } from '@/lib/ai/llm-client';
import { createUserPrompt } from '@/lib/ai/script-enhancer';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { StyleConfig } from '@/lib/db/schema/libraries';
import { getPrompt } from '@/lib/prompts';
import {
  CANONICAL_TARGET_SECONDS,
  type SampleBeat,
} from '@/lib/style/sample-videos';
import { z } from 'zod';

const sceneSplitSchema = z.object({
  scenes: z
    .array(
      z.object({
        imagePrompt: z.string().min(1),
        motionPrompt: z.string().min(1),
      })
    )
    .min(2)
    .max(3),
});

/** Extract the JSON object from an LLM reply, tolerating ```json fences / prose. */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    const snippet = text.trim().slice(0, 300);
    throw new Error(
      `Scene split returned no JSON object — model reply (${text.length} chars): ${
        snippet || '<empty completion>'
      }`
    );
  }
  return candidate.slice(start, end + 1);
}

function openRouterKey(): string {
  const key = getEnv().OPENROUTER_KEY;
  if (!key)
    throw new Error('OPENROUTER_KEY is required to enhance sample scripts');
  return key;
}

/** Run the brief through the app's `script/enhance` prompt → enhanced script prose. */
async function enhanceBrief(args: {
  brief: string;
  styleConfig: StyleConfig;
  aspectRatio: AspectRatio;
}): Promise<string> {
  const { prompt, compiled } = await getPrompt('script/enhance');
  const userPrompt = createUserPrompt(args.brief, {
    styleConfig: args.styleConfig,
    aspectRatio: args.aspectRatio,
    targetDuration: CANONICAL_TARGET_SECONDS,
  });
  return callLLM({
    model: RECOMMENDED_MODELS.creative,
    messages: [
      {
        role: 'system',
        content: `${compiled}\n\nReturn ONLY the enhanced script text. No JSON, no markdown formatting, no explanations.`,
      },
      { role: 'user', content: userPrompt },
    ],
    max_tokens: 4000,
    temperature: 0.7,
    prompt: prompt
      ? { name: prompt.name, version: prompt.version, isFallback: false }
      : undefined,
    observationName: 'sample-script-enhance',
    apiKey: openRouterKey(),
  });
}

/**
 * Break an enhanced script into 2–3 render-ready beats. Asks for JSON in the
 * prompt and parses it (more reliable across OpenRouter providers than native
 * structured outputs), then validates with `sceneSplitSchema` — no fallback.
 */
async function splitIntoBeats(args: {
  enhancedScript: string;
  aspectRatio: AspectRatio;
}): Promise<SampleBeat[]> {
  const reply = await callLLM({
    model: RECOMMENDED_MODELS.creative,
    messages: [
      {
        role: 'system',
        content:
          'You are a cinematographer turning a short ad script into 2-3 shots that cover it start to finish. ' +
          'For each shot give an imagePrompt (a vivid still-frame: subject, action, composition, framing) and a ' +
          'motionPrompt (one continuous ~5 second shot for image-to-video). Each motionPrompt is rendered by ' +
          'image-to-video from the SINGLE still in its imagePrompt, so the motion must be achievable from that ' +
          'one frame: a slow push-in or pull-out, pan, tilt, handheld drift, parallax, rack focus, and motion of ' +
          'subjects already visible in the still. Do NOT write moves that reveal new rooms, geometry, or subjects ' +
          'not in the still, large crane or aerial moves, or "pull back to reveal the whole X" — image-to-video ' +
          'warps instead of revealing. Keep the framing essentially the one described in imagePrompt. ' +
          'Keep the subject and setting consistent across shots. Do NOT describe the visual style, color grade, or ' +
          'film stock in either field — those are applied separately.\n\n' +
          'Return ONLY a JSON object of the form ' +
          '{"scenes":[{"imagePrompt":"…","motionPrompt":"…"}]} with 2-3 scenes. No markdown, no prose.',
      },
      {
        role: 'user',
        content: `Aspect ratio: ${args.aspectRatio}.\n\nScript:\n${args.enhancedScript}`,
      },
    ],
    max_tokens: 1500,
    temperature: 0.4,
    observationName: 'sample-script-split',
    apiKey: openRouterKey(),
  });

  const result = sceneSplitSchema.parse(JSON.parse(extractJson(reply)));
  return result.scenes.map((scene, i) => ({
    id: `shot-${i + 1}`,
    imagePrompt: scene.imagePrompt,
    motionPrompt: scene.motionPrompt,
  }));
}

/** Full canonical script for a style: brief → enhance → scene split → beats. */
export async function generateCanonicalScript(args: {
  brief: string;
  styleConfig: StyleConfig;
  aspectRatio: AspectRatio;
}): Promise<{ enhancedScript: string; beats: SampleBeat[] }> {
  const enhancedScript = await enhanceBrief(args);
  const beats = await splitIntoBeats({
    enhancedScript,
    aspectRatio: args.aspectRatio,
  });
  return { enhancedScript, beats };
}
