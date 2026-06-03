/**
 * LLM client for AI services
 * Uses @tanstack/ai-openrouter adapters for unified AI integration
 */

import type { TextModel } from '@/lib/ai/models';
import type { ChatMessage } from '@/lib/prompts';
import { chat, convertSchemaToJsonSchema } from '@tanstack/ai';
import { webSearchTool } from '@tanstack/ai-openrouter/tools';
import { z } from 'zod';
import { createAdapter } from './create-adapter';

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
  /**
   * Enable OpenRouter's web-search server tool for this request. The model
   * decides when to search; OpenRouter runs the search server-side inside the
   * agent loop and feeds results back. `true` uses defaults; pass an object to
   * tune the engine / result count / search prompt.
   */
  webSearch?:
    | boolean
    | { engine?: 'native' | 'exa'; maxResults?: number; searchPrompt?: string };

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
  };
}

/**
 * Assemble the `tools` array for `chat()`. Currently only the OpenRouter
 * web-search server tool, gated on `params.webSearch`. Returns `undefined`
 * (not an empty array) when no tool is requested so the option is omitted.
 */
function buildTools(params: LLMRequestParams) {
  if (!params.webSearch) return undefined;
  const opts = params.webSearch === true ? {} : params.webSearch;
  return [
    webSearchTool({
      ...(opts.engine && { engine: opts.engine }),
      ...(opts.maxResults !== undefined && { maxResults: opts.maxResults }),
      ...(opts.searchPrompt && { searchPrompt: opts.searchPrompt }),
    }),
  ];
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
  const tools = buildTools(params);
  return {
    adapter: createAdapter(params.model, params.apiKey),
    messages,
    systemPrompts,
    maxTokens: params.max_tokens,
    temperature: params.temperature,
    topP: params.top_p,
    modelOptions: buildModelOptions(params),
    ...(tools && { tools }),
    debug: params.debug ?? false,
  };
}

/**
 * Anthropic's native structured output (`output_config`) compiles the schema
 * into a grammar with a hard size cap that our large analysis schemas exceed
 * ("compiled grammar is too large"). Every other provider handles native
 * structured output fine, so only Anthropic needs a fallback: `json_object`
 * mode with the schema described in the prompt (the pre-#785 lenient
 * behaviour). Upstream tracking: https://github.com/TanStack/ai/issues/682
 */
export function isAnthropicModel(model: string): boolean {
  return model.startsWith('anthropic/');
}

/**
 * System-prompt instruction that pins a `json_object` response to `schema` —
 * used for the Anthropic fallback, where we can't ship a strict JSON-Schema
 * grammar.
 */
export function jsonSchemaInstruction(schema: z.ZodType): string {
  const jsonSchema = convertSchemaToJsonSchema(schema, {
    forStructuredOutput: true,
  });
  return (
    'You must respond with ONLY a single JSON object that conforms to this ' +
    'JSON Schema. No markdown, no code fences, no commentary:\n' +
    JSON.stringify(jsonSchema)
  );
}

/** Parse a `json_object` response, tolerating an accidental ```json fence. */
export function parseJsonObjectResponse(text: string): unknown {
  const unfenced = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '');
  return JSON.parse(unfenced);
}

/**
 * `{ systemPrompts, responseFormat }` for a workflow structured-output `chat()`
 * call (the explicit `modelOptions.responseFormat` path): native strict
 * `json_schema` for providers that support it, and the `json_object` +
 * schema-in-prompt fallback for Anthropic (whose strict grammar can't fit large
 * schemas). Mirrors the conditional in {@link callLLMStream}.
 */
export function structuredOutputConfig(
  model: string,
  responseSchema: z.ZodType,
  baseSystemPrompts: readonly string[]
) {
  if (isAnthropicModel(model)) {
    return {
      systemPrompts: [
        ...baseSystemPrompts,
        jsonSchemaInstruction(responseSchema),
      ],
      responseFormat: { type: 'json_object' as const },
    };
  }
  return {
    systemPrompts: [...baseSystemPrompts],
    responseFormat: {
      type: 'json_schema' as const,
      jsonSchema: {
        name: 'structured_output',
        schema: convertSchemaToJsonSchema(responseSchema, {
          forStructuredOutput: true,
        }),
        strict: true,
      },
    },
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
  // Drain the streaming path instead of calling `chat({ stream: false })`
  // directly, so non-streaming callers inherit its error handling. Upstream,
  // `chat({ stream: false })` collects text via `streamToText`, which only
  // accumulates TEXT_MESSAGE_CONTENT and *ignores RUN_ERROR entirely* — so a
  // 402 (out of credits), 429, or provider overload silently resolves to '' and
  // resurfaces downstream as a bogus "empty completion" / JSON-parse failure
  // (the #718 scene-split mystery). callLLMStream guards every non-content
  // event with throwIfRunError, so the real provider error propagates. Non-
  // streaming `chat()` already issues a streaming request under the hood
  // (runNonStreamingText wraps runStreamingText), so this keeps the wire shape
  // — and E2E aimock fixtures — identical.
  if (params.responseSchema) {
    const responseSchema = params.responseSchema;
    let parsed: T | undefined;
    for await (const chunk of callLLMStream({ ...params, responseSchema })) {
      if (chunk.done) parsed = chunk.parsed;
    }
    if (parsed === undefined) {
      throw new Error(
        'Structured LLM call returned no validated object (empty completion)'
      );
    }
    return parsed;
  }

  let accumulated = '';
  for await (const chunk of callLLMStream({
    ...params,
    responseSchema: undefined,
  })) {
    accumulated = chunk.accumulated;
  }
  return accumulated;
}

/**
 * Diagnostic detail pulled from a streaming `RUN_ERROR` event.
 *
 * `message` is frequently the provider's opaque headline like "Provider
 * returned error". Since `@tanstack/ai@0.24` the RUN_ERROR event also carries
 * `rawEvent` — the provider's *structured* error body (provider name, the
 * upstream model's error JSON, rate-limit/overload codes) that the
 * `{ message, code }` collapse deliberately drops. We surface `code`, `model`,
 * and `rawEvent` alongside `message`, and the caller logs them, so that context
 * isn't lost when the error propagates (e.g. up to a parent workflow's
 * "Child workflow … failed: …").
 */
export type RunErrorDetail = {
  message: string;
  code: string | undefined;
  model: string | undefined;
  /**
   * Provider's structured error body (AG-UI `rawEvent`), when the adapter
   * attached one. `undefined` for errors carrying no upstream body.
   */
  rawEvent: unknown;
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
  const rawEvent = 'rawEvent' in event ? event.rawEvent : undefined;
  return { message, code, model, rawEvent, event };
}

/**
 * Dig the upstream provider's *actual* error out of a RUN_ERROR `rawEvent`.
 * OpenRouter collapses provider failures to a generic "Provider returned
 * error", stashing the real message in `rawEvent` — at the top level or under
 * `metadata`, with the upstream body in `raw` (often a JSON string shaped like
 * `{ error: { message } }`, e.g. an Anthropic schema-validation message).
 * Returns a compact `provider=… <message>` string, or `undefined` when there's
 * no usable detail. Read defensively: `rawEvent` is an arbitrary provider frame.
 */
export function extractProviderErrorDetail(
  rawEvent: unknown
): string | undefined {
  if (!rawEvent || typeof rawEvent !== 'object') return undefined;
  const meta =
    'metadata' in rawEvent &&
    rawEvent.metadata &&
    typeof rawEvent.metadata === 'object'
      ? rawEvent.metadata
      : rawEvent;

  const provider =
    'provider_name' in meta && typeof meta.provider_name === 'string'
      ? meta.provider_name
      : undefined;

  let deepMessage: string | undefined;
  const raw = 'raw' in meta ? meta.raw : undefined;
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw);
      deepMessage =
        parsed &&
        typeof parsed === 'object' &&
        'error' in parsed &&
        parsed.error &&
        typeof parsed.error === 'object' &&
        'message' in parsed.error &&
        typeof parsed.error.message === 'string'
          ? parsed.error.message
          : raw;
    } catch {
      deepMessage = raw;
    }
  }

  const parts = [
    provider ? `provider=${provider}` : undefined,
    deepMessage,
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(' ') : undefined;
}

/**
 * Build the surfaced `Error.message` from a {@link RunErrorDetail}. `code` and
 * `model` (when present) ride along in a bracketed prefix so they survive in
 * the error string all the way up the call chain. The provider's real error
 * (dug out of `rawEvent`) is appended so the string is actionable even though
 * OpenRouter's top-level `message` is usually just "Provider returned error".
 */
export function formatRunErrorMessage(detail: RunErrorDetail): string {
  const tags = [
    detail.code,
    detail.model ? `model=${detail.model}` : undefined,
  ].filter((tag): tag is string => tag !== undefined);
  const suffix = tags.length > 0 ? ` [${tags.join(', ')}]` : '';
  const providerDetail = extractProviderErrorDetail(detail.rawEvent);
  const detailSuffix = providerDetail ? ` — ${providerDetail}` : '';
  return `LLM stream error${suffix}: ${detail.message}${detailSuffix}`;
}

function throwIfRunError(event: unknown): void {
  const detail = extractRunError(event);
  if (!detail) return;
  // Log the formatted string as the message (not as a `{ properties }` field)
  // so the actual error is visible in the dev pretty sink, which omits the
  // structured-field block. The full event still rides along for prod JSON.
  const message = formatRunErrorMessage(detail);
  logger.error(message, { runError: detail.event, rawEvent: detail.rawEvent });
  throw new Error(message);
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
  if (responseSchema && isAnthropicModel(params.model)) {
    // Anthropic can't compile a strict grammar for large schemas, so stream
    // plain JSON (`json_object`) with the schema pinned in the prompt, then
    // validate the accumulated text at the end.
    validateStructuredOutputSupport(params.model);
    for await (const event of chat({
      ...baseOptions,
      systemPrompts: [
        ...baseOptions.systemPrompts,
        jsonSchemaInstruction(responseSchema),
      ],
      modelOptions: {
        ...baseOptions.modelOptions,
        responseFormat: { type: 'json_object' as const },
      },
    })) {
      if (event.type === 'TEXT_MESSAGE_CONTENT') {
        accumulated += event.delta;
        yield { delta: event.delta, accumulated, done: false };
        continue;
      }
      throwIfRunError(event);
    }
    parsed = responseSchema.parse(parseJsonObjectResponse(accumulated));
  } else if (responseSchema) {
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
