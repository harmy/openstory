/**
 * LLM client for AI services
 * Uses @tanstack/ai-openrouter adapters for unified AI integration
 */

import type { TextModel } from '@/lib/ai/models';
import { getChatPrompt, type ChatMessage } from '@/lib/prompts';
import { chat } from '@tanstack/ai';
import { z } from 'zod';
import { ZERO_MICROS } from '../billing/money';
import { deductWorkflowCredits } from '../billing/workflow-deduction';
import type { ScopedDb } from '../db/scoped';
import { createAdapter } from './create-adapter';
import { getContextWindow } from './models.config';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ai', 'llm-client']);

export type StreamChunk<T = never> =
  | { done: false; delta: string; accumulated: string }
  | {
      done: true;
      delta: '';
      accumulated: string;
      /**
       * Validated structured output. Default `T = never` makes this `undefined`
       * when no `responseSchema` was provided; with a schema, narrows to `T | undefined`
       * (undefined when the stream ended without a `structured-output.complete` event).
       */
      parsed: T | undefined;
    };

export type ProgressCallback = (progress: {
  type: 'chunk' | 'complete';
  text: string;
  parsed?: unknown;
}) => void;

type ProviderPreference = {
  order?: string[];
  only?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
};

export type LLMRequestParams<T = unknown> = {
  model: TextModel;
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  stream?: boolean;
  provider?: ProviderPreference;
  /** Observation name for Langfuse (forwarded via AI event bridge) */
  observationName?: string;
  /** Prompt reference for Langfuse trace linking */
  prompt?: { name: string; version: number; isFallback: boolean };
  /** Tags for Langfuse filtering */
  tags?: string[];
  /** Additional metadata for Langfuse */
  metadata?: Record<string, unknown>;
  /** User id for Langfuse/PostHog user attribution */
  userId?: string;
  /** Session id for Langfuse trace grouping (typically sequenceId) */
  sessionId?: string;
  responseSchema?: z.ZodType<T>;
  apiKey?: string;
  /** OpenRouter plugins (e.g. web search) to enable for this request */
  plugins?: Array<{ id: 'web'; max_results?: number }>;

  /** Debug mode for LLM client */
  debug?: boolean;
};

/**
 * Models that support structured outputs via OpenRouter.
 * https://openrouter.ai/docs/guides/features/structured-outputs
 */
const STRUCTURED_OUTPUT_MODELS = new Set([
  'x-ai/grok-4.3',
  'anthropic/claude-sonnet-4.6',
  'x-ai/grok-4.20',
  'anthropic/claude-opus-4.6',
  'deepseek/deepseek-v3.2',
  'z-ai/glm-5',
  'google/gemini-3.1-pro-preview',
  'openai/gpt-5.4',
  'google/gemini-3-flash-preview',
  'mistralai/mistral-small-2603',
  'openai/gpt-5.4-mini',
  'bytedance-seed/seed-2.0-mini',
  'openai/gpt-5.4-nano',
]);

export function modelSupportsStructuredOutputs(model: string): boolean {
  return STRUCTURED_OUTPUT_MODELS.has(model);
}

export const RECOMMENDED_MODELS = {
  creative: 'anthropic/claude-sonnet-4.6',
  structured: 'anthropic/claude-sonnet-4.6',
  fast: 'anthropic/claude-sonnet-4.6',
  premium: 'anthropic/claude-sonnet-4.6',
} as const;

/**
 * System messages must be strings (they become systemPrompts on the adapter).
 * Collapse any content-part array down to its text parts, discarding any
 * non-text parts (images in a system message have nowhere to go).
 */
function systemContentToString(content: ChatMessage['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((part) => (part.type === 'text' ? part.content : ''))
    .filter(Boolean)
    .join('\n');
}

type AdapterMessage = {
  role: 'user' | 'assistant';
  content: ChatMessage['content'];
};

function convertMessages(messages: ChatMessage[]): {
  systemPrompts: string[];
  messages: AdapterMessage[];
} {
  const systemPrompts: string[] = [];
  const chatMessages: AdapterMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompts.push(systemContentToString(msg.content));
    } else {
      chatMessages.push({ role: msg.role, content: msg.content });
    }
  }

  return { systemPrompts, messages: chatMessages };
}

function buildModelOptions(params: LLMRequestParams) {
  return {
    ...(params.provider && { provider: params.provider }),
    frequency_penalty: params.frequency_penalty,
    presence_penalty: params.presence_penalty,
    ...(params.plugins && { plugins: params.plugins }),
  };
}

function validateStructuredOutputSupport(model: string): void {
  if (!modelSupportsStructuredOutputs(model)) {
    throw new Error(
      `Model ${model} does not support structured outputs. ` +
        `Supported models: ${[...STRUCTURED_OUTPUT_MODELS].join(', ')}`
    );
  }
}

function buildChatMetadata(params: LLMRequestParams) {
  return {
    observationName: params.observationName,
    prompt: params.prompt,
    tags: params.tags,
    metadata: params.metadata,
    userId: params.userId,
    sessionId: params.sessionId,
  };
}

function baseChatOptions(params: LLMRequestParams) {
  const { systemPrompts, messages } = convertMessages(params.messages);
  return {
    adapter: createAdapter(params.model, params.apiKey),
    messages,
    systemPrompts,
    maxTokens: params.max_tokens,
    temperature: params.temperature,
    topP: params.top_p,
    modelOptions: buildModelOptions(params),
    debug: params.debug ?? false,
  };
}

/**
 * @tanstack/ai's chat orchestrator validates `outputSchema` upstream and surfaces
 * the parsed object through the terminal `structured-output.complete` event (stream)
 * or as the resolved value (non-stream) — but the return is typed `unknown` because
 * Zod's `~standard` doesn't include the JSON-Schema converter `InferSchemaType` keys
 * off. We run `responseSchema.parse` here to recover the `T` binding without a cast
 * (the orchestrator already validated, so this is a near-free no-op).
 */
export async function callLLM<T>(
  params: LLMRequestParams<T> & { responseSchema: z.ZodType<T> }
): Promise<T>;
export async function callLLM(
  params: LLMRequestParams & { responseSchema?: undefined }
): Promise<string>;
export async function callLLM<T>(
  params: LLMRequestParams<T>
): Promise<T | string> {
  if (params.responseSchema) {
    validateStructuredOutputSupport(params.model);
    const result = await chat({
      ...baseChatOptions(params),
      stream: false,
      metadata: buildChatMetadata(params),
      outputSchema: params.responseSchema,
    });
    return params.responseSchema.parse(result);
  }

  return chat({
    ...baseChatOptions(params),
    stream: false,
    metadata: buildChatMetadata(params),
    outputSchema: undefined,
  });
}

/**
 * Diagnostic detail pulled from a streaming `RUN_ERROR` event.
 *
 * The `@tanstack/ai-openrouter` adapter collapses the provider's error to
 * `{ message, code }` before it reaches us — its `processStreamChunks`
 * rethrows `new Error(chunk.error.message)`, dropping OpenRouter's
 * `error.metadata` (provider name, raw upstream body). So `message` is
 * frequently the provider's opaque headline like "Provider returned error".
 * We surface `code` and `model` alongside it, and the caller logs the full
 * event, so that context isn't lost when the error propagates (e.g. up to a
 * parent workflow's "Child workflow … failed: …").
 */
export type RunErrorDetail = {
  message: string;
  code: string | undefined;
  model: string | undefined;
  /** The full RUN_ERROR event, for structured logging. */
  event: unknown;
};

/**
 * Narrow a stream event to a `RUN_ERROR` and extract its diagnostic fields,
 * or return `null` for any other event. Takes `unknown` because `chat()`'s
 * yielded event union is wide and not cleanly nameable — this is a type guard
 * over an arbitrary (possibly malformed) provider frame. Fields are read
 * defensively: a bad frame can carry a non-string `message`.
 */
export function extractRunError(event: unknown): RunErrorDetail | null {
  if (
    !event ||
    typeof event !== 'object' ||
    !('type' in event) ||
    event.type !== 'RUN_ERROR'
  ) {
    return null;
  }
  const message =
    'message' in event && typeof event.message === 'string'
      ? event.message
      : JSON.stringify(
          'message' in event ? event.message : 'Unknown LLM error'
        );
  const code =
    'code' in event && typeof event.code === 'string' ? event.code : undefined;
  const model =
    'model' in event && typeof event.model === 'string'
      ? event.model
      : undefined;
  return { message, code, model, event };
}

/**
 * Build the surfaced `Error.message` from a {@link RunErrorDetail}. `code` and
 * `model` (when present) ride along in a bracketed prefix so they survive in
 * the error string all the way up the call chain.
 */
export function formatRunErrorMessage(detail: RunErrorDetail): string {
  const tags = [
    detail.code,
    detail.model ? `model=${detail.model}` : undefined,
  ].filter((tag): tag is string => tag !== undefined);
  const suffix = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  return `LLM stream error${suffix}: ${detail.message}`;
}

function throwIfRunError(event: unknown): void {
  const detail = extractRunError(event);
  if (!detail) return;
  logger.error('LLM stream RUN_ERROR', { runError: detail.event });
  throw new Error(formatRunErrorMessage(detail));
}

export function callLLMStream<T>(
  params: LLMRequestParams<T> & { responseSchema: z.ZodType<T> }
): AsyncGenerator<StreamChunk<T>>;
export function callLLMStream(
  params: LLMRequestParams & { responseSchema?: undefined }
): AsyncGenerator<StreamChunk>;
export async function* callLLMStream<T>(
  params: LLMRequestParams<T>
): AsyncGenerator<StreamChunk<T>> {
  let accumulated = '';
  let parsed: T | undefined;

  const baseOptions = {
    ...baseChatOptions(params),
    metadata: buildChatMetadata(params),
    modelOptions: {
      ...buildModelOptions(params),
      streamOptions: { includeUsage: true },
    },
    stream: true as const,
  };

  const responseSchema = params.responseSchema;
  if (responseSchema) {
    validateStructuredOutputSupport(params.model);
    for await (const event of chat({
      ...baseOptions,
      outputSchema: responseSchema,
    })) {
      if (
        event.type === 'TEXT_MESSAGE_CONTENT' &&
        typeof event.delta === 'string'
      ) {
        accumulated += event.delta;
        yield { delta: event.delta, accumulated, done: false };
        continue;
      }
      if (
        event.type === 'CUSTOM' &&
        event.name === 'structured-output.complete'
      ) {
        // Orchestrator already validated against outputSchema before emitting,
        // but the event payload is typed `unknown`. Re-parse to recover `T`.
        parsed = responseSchema.parse(event.value.object);
        continue;
      }
      throwIfRunError(event);
    }
  } else {
    for await (const event of chat(baseOptions)) {
      if (event.type === 'TEXT_MESSAGE_CONTENT') {
        accumulated += event.delta;
        yield { delta: event.delta, accumulated, done: false };
        continue;
      }
      throwIfRunError(event);
    }
  }

  yield { delta: '', accumulated, done: true, parsed };
}

export type DurableLLMCallConfig<TSchema extends z.ZodType> = {
  name: string;
  promptName: string;
  promptVariables?: Record<string, string>;
  modelId: TextModel;
  responseSchema: TSchema;
  additionalMetadata?: Record<string, unknown>;
};

/**
 * Execute a durable LLM call with the standard 3-step pattern:
 * 1. Prepare: Fetch prompt from Langfuse, emit phase start
 * 2. Call: LLM call via context.run() + @tanstack/ai-openrouter
 * 3. Log & Process: Log to Langfuse, parse response, emit phase complete
 *
 * Uses context.run() instead of context.api.openai.call() to avoid
 * passing API keys in headers that get stored in Upstash logs.
 */
export async function callChat<TSchema extends z.ZodType>(
  config: DurableLLMCallConfig<TSchema>,
  scopedDb: ScopedDb
) {
  const { name, modelId, promptName, promptVariables, responseSchema } = config;
  const logTags = [name, promptName, 'analysis'];
  const logMetadata = {
    name,
    modelId,
    promptName,
    promptVariables,
    ...config.additionalMetadata,
  };

  // Step 1: Prepare -- fetch prompt and emit phase start
  // Prompt is the Langfuse prompt reference, messages is the compiled messages
  const { prompt, messages } = await getChatPrompt(promptName, promptVariables);

  // Step 2: Durable LLM call (QStash retries step delivery on failure)
  // Determine the API key to use
  const openRouterApiKeyInfo = await scopedDb.apiKeys.resolveKey('openrouter');
  // Create the adapter using the API key
  const adapter = createAdapter(modelId, openRouterApiKeyInfo.key);

  logger.info(`[LLM:${name}] Starting call`, {
    model: modelId,
    keySource: openRouterApiKeyInfo.source,
    messageCount: messages.length,
  });

  const systemPrompts: string[] = [];
  const chatMessages: Array<{
    role: 'user' | 'assistant';
    content: string;
  }> = [];

  for (const msg of messages) {
    const flat = systemContentToString(msg.content);
    if (msg.role === 'system') {
      systemPrompts.push(flat);
    } else {
      chatMessages.push({ role: msg.role, content: flat });
    }
  }

  const jsonResponse = await chat({
    adapter,
    messages: chatMessages,
    systemPrompts,
    stream: false,
    maxTokens: Math.floor(getContextWindow(config.modelId) * 0.5),
    metadata: {
      observationName: promptName,
      prompt,
      tags: logTags,
      metadata: logMetadata,
    },
    outputSchema: responseSchema,
    debug: false,
  });

  logger.info(`[LLM:${name}] Call succeeded`);

  // Deduct LLM credits (cost tracked via Langfuse; adapter doesn't expose per-call usage)
  // TODO: Add cost calculation
  await deductWorkflowCredits({
    scopedDb: scopedDb,
    costMicros: ZERO_MICROS,
    usedOwnKey: openRouterApiKeyInfo.source === 'team',
    description: `LLM analysis (${modelId})`,
    metadata: {
      model: modelId,
      stepName: name,
    },
  });

  return responseSchema.parse(jsonResponse);
}
