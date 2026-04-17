/**
 * Tracing initialization and workflow trace recording.
 * Uses standard OpenTelemetry with pluggable exporters:
 * - Langfuse (LangfuseSpanProcessor) — optional
 * - PostHog (PostHogTraceExporter) — optional
 * Any OTel-compatible backend can be added as another span processor.
 */

import { getEnv } from '#env';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { trace } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  BatchSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { PostHogTraceExporter } from '@posthog/ai/otel';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

import { endSpanSuccess, startGenAISpan, withTraceContext } from './tracer';

const processors: SpanProcessor[] = [];

/** Whether Langfuse is enabled — derived from both keys being set. */
export function isLangfuseEnabled(): boolean {
  const env = getEnv();
  return !!env.LANGFUSE_PUBLIC_KEY && !!env.LANGFUSE_SECRET_KEY;
}

/** Whether Langfuse prompt management is enabled (fetch prompts from Langfuse API). */
export function isLangfusePromptsEnabled(): boolean {
  const env = getEnv();
  return isLangfuseEnabled() && env.LANGFUSE_PROMPTS_ENABLED === 'true';
}

/**
 * Initialize tracing with all configured exporters.
 * Call once at module load before any traced operations.
 * Silently skips if no exporters are configured.
 */
export function initTracing(): void {
  const env = getEnv();

  // Langfuse exporter
  const langfusePublicKey = env.LANGFUSE_PUBLIC_KEY;
  const langfuseSecretKey = env.LANGFUSE_SECRET_KEY;

  if (langfusePublicKey && langfuseSecretKey) {
    processors.push(
      new LangfuseSpanProcessor({
        publicKey: langfusePublicKey,
        secretKey: langfuseSecretKey,
        baseUrl: env.LANGFUSE_BASE_URL,
        exportMode: 'batched',
      })
    );
    console.log('[Tracing] Langfuse exporter enabled');
  }

  // PostHog exporter
  const posthogToken = env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;

  if (posthogToken) {
    const host = env.VITE_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com';
    processors.push(
      new BatchSpanProcessor(
        new PostHogTraceExporter({ apiKey: posthogToken, host })
      )
    );
    console.log('[Tracing] PostHog exporter enabled');
  }

  if (processors.length === 0) {
    console.log('[Tracing] Disabled — no exporters configured');
    return;
  }

  try {
    const provider = new BasicTracerProvider({ spanProcessors: processors });
    trace.setGlobalTracerProvider(provider);
  } catch (error) {
    console.error('[Tracing] Failed to register provider:', error);
    return;
  }
  console.log('[Tracing] Initialized with %d exporter(s)', processors.length);
}

/**
 * Flush all pending traces to configured exporters.
 * Call at the end of request handling in serverless environments.
 */
export async function flushTracing(): Promise<void> {
  await Promise.all(processors.map((p) => p.forceFlush()));
}

/**
 * Record a completed workflow trace.
 * Call inside context.run() to ensure it only runs once (durable step).
 *
 * @param traceName - Name for the trace (e.g., 'analyzeScriptWorkflow')
 * @param input - Input data that was passed to the workflow
 * @param output - Output data produced by the workflow
 * @param sequenceId - Used as the Langfuse sessionId to group traces
 * @param userId - Optional user ID for user attribution
 * @param model - Optional model name
 * @param startTime - Optional start time for the trace
 */
export async function recordWorkflowTrace<TOutput>(
  traceName: string,
  _input: unknown,
  output: TOutput,
  sequenceId: string,
  userId: string | undefined,
  model?: string,
  startTime?: Date
): Promise<void> {
  withTraceContext(
    {
      sessionId: sequenceId,
      ...(userId && { userId }),
      ...(model && { tags: [`model:${model}`] }),
    },
    () => {
      const span = startGenAISpan(traceName, {
        model: model ?? 'unknown',
        operation: 'generate_content',
        sessionId: sequenceId,
        userId,
        ...(model && { metadata: { model } }),
      });

      if (startTime) {
        span.setAttribute(
          'langfuse.observation.completion_start_time',
          startTime.toISOString()
        );
      }

      endSpanSuccess(
        span,
        typeof output === 'object' ? output : { result: output }
      );
    }
  );
}

/**
 * Prompt reference for Langfuse trace linking.
 * Compatible with TextPromptClient and ChatPromptClient from @langfuse/client.
 * Must include at minimum: name, version, isFallback (additional properties allowed).
 */
export type PromptReference = {
  name: string;
  version: number;
  isFallback: boolean;
};
