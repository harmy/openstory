/**
 * AI Server Functions
 * End-to-end type-safe functions for AI operations
 */

import { getEnv } from '#env';
import {
  callLLM,
  callLLMStream,
  RECOMMENDED_MODELS,
} from '@/lib/ai/llm-client';
import { isValidAnalysisModelId } from '@/lib/ai/models.config';
import {
  checkForInjectionAttempts,
  sanitizeScriptContent,
} from '@/lib/ai/prompt-validation';
import {
  createUserPrompt,
  RateLimiter,
  scriptEnhancementRateLimiter,
} from '@/lib/ai/script-enhancer';
import { estimateLLMCost } from '@/lib/billing/cost-estimation';
import { aspectRatioSchema } from '@/lib/constants/aspect-ratios';
import { StyleConfigSchema } from '@/lib/db/schema/libraries';
import type { ScopedDb } from '@/lib/db/scoped';
import { InsufficientCreditsError } from '@/lib/errors';
import {
  getPrompt,
  type ChatMessage,
  type ChatMessageContentPart,
} from '@/lib/prompts';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware, frameAccessMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'ai']);

const promptShorteningRateLimiter = new RateLimiter(10, 60_000);
const sceneDurationEstimationRateLimiter = new RateLimiter(20, 60_000);

const SHORTEN_PROMPT_SYSTEM = `You are an expert at condensing image generation prompts while preserving all critical visual elements.

Your task is to shorten image prompts by:
- Removing verbose descriptions and redundant words
- Keeping essential visual elements: subjects, composition, style, lighting, mood
- Maintaining technical parameters (aspect ratio, quality, etc.)
- Preserving artistic style references and specific details
- Using concise, impactful language

Target 50-75% reduction in length while keeping the prompt's core meaning intact.

Return ONLY the shortened prompt text, nothing else. No explanations, no preamble.`;

function getClientIP(): string {
  const request = getRequest();
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0] ||
    request.headers.get('x-real-ip') ||
    'anonymous'
  );
}

function enforceRateLimit(limiter: RateLimiter, key: string): void {
  if (limiter.isAllowed(key)) return;
  const remainingMs = limiter.getRemainingTime(key);
  throw new Error(
    `Rate limit exceeded. Please try again in ${Math.ceil(remainingMs / 1000)} seconds.`
  );
}

/**
 * Check pre-flight billing and return a deduct function.
 * Returns `undefined` when billing is skipped (disabled or team has own key).
 */
async function prepareBilling(
  scopedDb: ScopedDb,
  description: string,
  metadata?: Record<string, unknown>
): Promise<(() => Promise<void>) | undefined> {
  const teamHasOwnKey = await scopedDb.apiKeys.hasKey('openrouter');
  if (teamHasOwnKey) return undefined;

  const cost = estimateLLMCost(1);
  const canAfford = await scopedDb.billing.hasEnoughCredits(cost);
  if (!canAfford) {
    throw new InsufficientCreditsError(
      `Insufficient credits for ${description.toLowerCase()}`
    );
  }

  return async () => {
    if (cost > 0) {
      await scopedDb.billing.deductCredits(cost, {
        description,
        metadata,
      });
    }
  };
}

// -- Shorten Prompt --

const shortenPromptInputSchema = z.object({
  prompt: z
    .string()
    .min(20, 'Prompt must be at least 20 characters')
    .max(5000, 'Prompt too long'),
});

export const shortenPromptFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(shortenPromptInputSchema))
  .handler(async ({ data, context }) => {
    enforceRateLimit(promptShorteningRateLimiter, getClientIP());

    if (!getEnv().OPENROUTER_KEY) {
      throw new Error('AI service not configured');
    }

    const deduct = await prepareBilling(
      context.scopedDb,
      `Prompt shortening (${RECOMMENDED_MODELS.fast})`,
      { model: RECOMMENDED_MODELS.fast }
    );

    const shortenedPrompt = await callLLM({
      model: RECOMMENDED_MODELS.fast,
      messages: [
        { role: 'system' as const, content: SHORTEN_PROMPT_SYSTEM },
        { role: 'user' as const, content: data.prompt },
      ],
      max_tokens: 500,
      temperature: 0.3,
      observationName: 'shortenPrompt',
      userId: context.user.id,
    });

    await deduct?.();

    if (!shortenedPrompt) {
      throw new Error('No response received from AI service');
    }

    const trimmedPrompt = shortenedPrompt.trim();
    if (trimmedPrompt.length < 20) {
      throw new Error('Shortened prompt is too short. Please try again.');
    }

    return {
      originalPrompt: data.prompt,
      shortenedPrompt: trimmedPrompt,
      originalLength: data.prompt.length,
      shortenedLength: trimmedPrompt.length,
      reductionPercent: Math.round(
        ((data.prompt.length - trimmedPrompt.length) / data.prompt.length) * 100
      ),
    };
  });

// -- Estimate Scene Duration --

const ESTIMATE_SCENE_DURATION_SYSTEM = `You estimate how many seconds a single scene runs as a short-form video clip. Default to short — most scenes are 3-6 seconds.

Honor explicit duration cues in the script. If the script text references a length (e.g. "10 second clip", "5s", "for thirty seconds", "a brief two-second beat"), use that number directly.

Otherwise:
- Pure visual / establishing shot, no dialogue → 3-4
- Single short action or reaction beat → 4-5
- One spoken line → time the dialogue at ~200 spoken words per minute and add 1 second of breathing room
- Multiple actions or lines → sum the components

Avoid generous padding. Reach 10+ seconds only when the script clearly demands it. Never invent visual moments that aren't in the script.

Return ONLY valid JSON: {"durationSeconds": <integer between 1 and 60>}.`;

// Schema sent to the LLM as the structured-output JSON Schema. Use plain
// `z.number()` rather than `.int()` / `.min()` / `.max()` — Zod injects
// JS-safe-integer bounds for `.int()`, and Amazon Bedrock (one of the
// OpenRouter providers for Sonnet) rejects ANY `minimum`/`maximum` on
// integer types: "For 'integer' type, properties maximum, minimum are not
// supported". Range + integer enforcement happen post-parse via clamp.
const sceneDurationResponseSchema = z.object({
  durationSeconds: z.number(),
});

const SCENE_DURATION_MIN = 1;
const SCENE_DURATION_MAX = 60;
const clampDuration = (n: number) =>
  Math.min(SCENE_DURATION_MAX, Math.max(SCENE_DURATION_MIN, Math.round(n)));

const estimateSceneDurationInputSchema = z.object({
  sequenceId: ulidSchema,
  frameId: ulidSchema,
  extract: z
    .string()
    .min(1, 'Scene script is empty')
    .max(5000, 'Scene script too long for estimation'),
});

export const estimateSceneDurationFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(estimateSceneDurationInputSchema))
  .handler(async ({ data, context }) => {
    enforceRateLimit(sceneDurationEstimationRateLimiter, getClientIP());

    if (!getEnv().OPENROUTER_KEY) {
      throw new Error('AI service not configured');
    }

    const analysisModel =
      (isValidAnalysisModelId(context.sequence.analysisModel)
        ? context.sequence.analysisModel
        : null) ?? RECOMMENDED_MODELS.fast;

    const deduct = await prepareBilling(
      context.scopedDb,
      `Scene duration estimate (${analysisModel})`,
      { model: analysisModel, frameId: context.frame.id }
    );

    const sceneMetadata = context.frame.metadata?.metadata;
    const userPrompt = [
      sceneMetadata?.title && `Title: ${sceneMetadata.title}`,
      sceneMetadata?.location && `Location: ${sceneMetadata.location}`,
      sceneMetadata?.timeOfDay && `Time of day: ${sceneMetadata.timeOfDay}`,
      sceneMetadata?.storyBeat && `Story beat: ${sceneMetadata.storyBeat}`,
      '',
      'Script:',
      data.extract,
    ]
      .filter(Boolean)
      .join('\n');

    const response = await callLLM({
      model: analysisModel,
      messages: [
        { role: 'system' as const, content: ESTIMATE_SCENE_DURATION_SYSTEM },
        { role: 'user' as const, content: userPrompt },
      ],
      max_tokens: 50,
      temperature: 0.2,
      observationName: 'estimateSceneDuration',
      userId: context.user.id,
      responseSchema: sceneDurationResponseSchema,
    });

    await deduct?.();

    return { durationSeconds: clampDuration(response.durationSeconds) };
  });

// -- Enhance Script --

const enhanceScriptInputSchema = z.object({
  script: z
    .string()
    .min(10, 'Script must be at least 10 characters')
    .max(50000, 'Script too long'),
  targetDuration: z.number().min(5).max(180).optional(),
  tone: z.enum(['dramatic', 'comedic', 'documentary', 'action']).optional(),
  style: z.string().optional(),
  styleConfig: StyleConfigSchema.partial().optional(),
  analysisModel: z.string().optional(),
  aspectRatio: aspectRatioSchema.optional(),
  elements: z
    .array(
      z.object({
        token: z.string().min(1),
        description: z.string().nullable().optional(),
        imageUrl: z.string().url(),
      })
    )
    .optional(),
});

export const enhanceScriptStreamFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(enhanceScriptInputSchema))
  .handler(async function* ({ data, context }) {
    enforceRateLimit(scriptEnhancementRateLimiter, getClientIP());

    const deduct = await prepareBilling(context.scopedDb, 'Script enhancement');

    if (checkForInjectionAttempts(data.script)) {
      logger.warn('Script enhancement: Potential injection attempt detected');
    }

    const sanitized = sanitizeScriptContent(data.script);
    const { prompt, compiled } = await getPrompt('script/enhance');
    const elements = data.elements ?? [];
    const userPrompt = createUserPrompt(sanitized, {
      styleConfig: data.styleConfig,
      aspectRatio: data.aspectRatio,
      targetDuration: data.targetDuration,
      elements: elements.length > 0 ? elements : undefined,
    });

    const model =
      data.analysisModel && isValidAnalysisModelId(data.analysisModel)
        ? data.analysisModel
        : RECOMMENDED_MODELS.creative;

    const systemMessage = `${compiled}\n\nReturn ONLY the enhanced script text. No JSON, no markdown formatting, no explanations.`;

    const userContent: string | ChatMessageContentPart[] =
      elements.length > 0
        ? [
            { type: 'text', content: userPrompt },
            ...elements.map<ChatMessageContentPart>((el) => ({
              type: 'image',
              source: { type: 'url', value: el.imageUrl },
            })),
          ]
        : userPrompt;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userContent },
    ];

    const promptRef = prompt
      ? {
          name: prompt.name,
          version: prompt.version,
          isFallback: false,
        }
      : undefined;

    // Web search runs as OpenRouter's server tool — the model decides when to
    // search and OpenRouter executes it server-side within the agent loop.
    // Gate it out of E2E entirely (record + replay): live search results would
    // make the recorded OpenRouter request/response non-deterministic.
    const useWebSearch = getEnv().E2E_TEST !== 'true';
    for await (const chunk of callLLMStream({
      model,
      messages,
      max_tokens: 4000,
      temperature: 0.7,
      ...(useWebSearch && { webSearch: true }),
      observationName: 'script-enhance',
      prompt: promptRef,
      tags: ['script-enhance', model],
      userId: context.user.id,
      metadata: {
        teamId: context.teamId,
        elementCount: elements.length,
        targetDuration: data.targetDuration,
        aspectRatio: data.aspectRatio,
      },
    })) {
      if (chunk.delta) {
        yield { delta: chunk.delta };
      }
    }

    await deduct?.();
  });
