/**
 * AI Event Bridge
 * Subscribes to TanStack AI events and fans out to two sinks:
 *  1. OpenTelemetry gen_ai.* spans (Langfuse, Datadog, any OTel backend).
 *  2. PostHog `$ai_generation` events via the posthog-node SDK (because
 *     PostHog's OTLP ingest can only set `distinct_id` from Resource
 *     attributes, which are provider-global — not per-request).
 *
 * Metadata contract: callers pass observability hints via chat({ metadata: { ... } }).
 * TanStack AI places this at event.payload.options.metadata.
 * We parse it with zod since the shape is unknown at the type level.
 */

import type { Span } from '@opentelemetry/api';
import { aiEventClient } from '@tanstack/ai-event-client';
import { z } from 'zod';

import { getPostHogClient } from '@/lib/posthog-server';
import {
  endSpanError,
  endSpanSuccess,
  setSpanUsage,
  startGenAISpan,
} from './tracer';

const llmMetadataSchema = z.object({
  observationName: z.string().optional(),
  prompt: z
    .object({
      name: z.string(),
      version: z.number(),
      isFallback: z.boolean(),
    })
    .optional(),
  tags: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  sessionId: z.string().optional(),
  userId: z.string().optional(),
});

type RequestState = {
  span: Span;
  meta: z.infer<typeof llmMetadataSchema>;
  model: string;
  provider: string;
  startedAt: number;
  systemPrompts?: string[];
  messages: Array<{ role: string; content: string }>;
};

const inflight = new Map<string, RequestState>();
let initialized = false;

function capturePostHogGeneration(
  state: RequestState,
  result: {
    content?: string;
    inputTokens?: number;
    outputTokens?: number;
    error?: string;
  }
): void {
  const userId = state.meta.userId;
  if (!userId) return; // No user to attribute to — skip PostHog event.
  const posthog = getPostHogClient();
  if (!posthog) return;

  const ctx = state.span.spanContext();
  const latencySeconds = (Date.now() - state.startedAt) / 1000;

  const inputMessages = [
    ...(state.systemPrompts?.map((content) => ({
      role: 'system' as const,
      content,
    })) ?? []),
    ...state.messages,
  ];

  posthog.capture({
    distinctId: userId,
    event: '$ai_generation',
    properties: {
      $ai_lib: 'openstory',
      $ai_trace_id: ctx.traceId,
      $ai_span_id: ctx.spanId,
      $ai_provider: state.provider,
      $ai_model: state.model,
      $ai_input: inputMessages,
      $ai_input_tokens: result.inputTokens ?? 0,
      ...(result.outputTokens !== undefined && {
        $ai_output_tokens: result.outputTokens,
      }),
      ...(result.content !== undefined && {
        $ai_output_choices: [{ role: 'assistant', content: result.content }],
      }),
      $ai_latency: latencySeconds,
      $ai_http_status: result.error ? 500 : 200,
      ...(result.error && { $ai_error: result.error, $ai_is_error: true }),
      ...(state.meta.sessionId && { $ai_session_id: state.meta.sessionId }),
      ...(state.meta.observationName && {
        $ai_span_name: state.meta.observationName,
      }),
      ...(state.meta.tags?.length && { $ai_tags: state.meta.tags }),
    },
  });
}

export function initAIEventBridge(): void {
  if (initialized) return;
  initialized = true;
  aiEventClient.on(
    'text:request:started',
    (event) => {
      const payload = event.payload;
      const parsed = llmMetadataSchema.safeParse(payload.options?.metadata);
      const meta = parsed.success ? parsed.data : {};
      const name = meta.observationName ?? `${payload.provider}-call`;

      const span = startGenAISpan(name, {
        model: payload.model,
        provider: payload.provider,
        operation: 'chat',
        sessionId: meta.sessionId,
        userId: meta.userId,
        prompt: meta.prompt,
        tags: meta.tags,
        metadata: meta.metadata,
      });

      inflight.set(payload.requestId, {
        span,
        meta,
        model: payload.model,
        provider: payload.provider,
        startedAt: Date.now(),
        systemPrompts: payload.systemPrompts,
        messages: [],
      });
    },
    { withEventTarget: true }
  );

  aiEventClient.on(
    'text:message:created',
    (event) => {
      const payload = event.payload;
      const reqId = payload.requestId ?? payload.streamId;
      if (!reqId) return;
      const state = inflight.get(reqId);
      if (!state) return;
      if (payload.role === 'user' || payload.role === 'system') {
        state.messages.push({ role: payload.role, content: payload.content });
      }
    },
    { withEventTarget: true }
  );

  aiEventClient.on(
    'text:request:completed',
    (event) => {
      const payload = event.payload;
      const state = inflight.get(payload.requestId);
      if (!state) return;

      state.span.setAttribute(
        'gen_ai.input.messages',
        JSON.stringify({
          systemPrompts: state.systemPrompts,
          messages: state.messages,
        })
      );

      if (payload.usage) {
        setSpanUsage(state.span, {
          inputTokens: payload.usage.promptTokens,
          outputTokens: payload.usage.completionTokens,
        });
      }

      endSpanSuccess(state.span, payload.content);

      capturePostHogGeneration(state, {
        content: payload.content,
        inputTokens: payload.usage?.promptTokens,
        outputTokens: payload.usage?.completionTokens,
      });

      inflight.delete(payload.requestId);
    },
    { withEventTarget: true }
  );

  aiEventClient.on(
    'text:chunk:error',
    (event) => {
      const payload = event.payload;
      const reqId = payload.requestId ?? payload.streamId;
      const state = inflight.get(reqId);
      if (!state) return;

      endSpanError(state.span, payload.error);

      capturePostHogGeneration(state, {
        error:
          typeof payload.error === 'string'
            ? payload.error
            : JSON.stringify(payload.error),
      });

      inflight.delete(reqId);
    },
    { withEventTarget: true }
  );
}
