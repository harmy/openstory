/**
 * Tracing initialization and workflow trace recording.
 *
 * OTel is wired up with a {@link LangfuseSpanProcessor} for Langfuse.
 * PostHog LLM analytics are NOT handled via OTel because PostHog's OTLP
 * ingest reads `distinct_id` from Resource attributes only (provider-global,
 * not per-request). Instead, {@link ai-event-bridge} captures
 * `$ai_generation` events via the `posthog-node` SDK with the correct
 * per-request `distinctId`.
 */

import { getEnv } from '#env';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { trace } from '@opentelemetry/api';
import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base';
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base';

import { getPostHogClient } from '@/lib/posthog-server';
import { endSpanSuccess, startGenAISpan, withTraceContext } from './tracer';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'observability', 'langfuse']);

const processors: SpanProcessor[] = [];
let initialized = false;

/** Whether Langfuse is enabled — derived from both keys being set. */
function isLangfuseEnabled(): boolean {
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
  if (initialized) return;
  initialized = true;
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
    logger.info('Langfuse exporter enabled');
  }

  if (processors.length === 0) {
    logger.info('Disabled — no exporters configured');
    return;
  }

  try {
    const provider = new BasicTracerProvider({ spanProcessors: processors });
    trace.setGlobalTracerProvider(provider);
  } catch (error) {
    logger.error('Failed to register provider:', { err: error });
    return;
  }
  logger.info('Initialized with %d exporter(s)', { data: processors.length });
}

/**
 * Flush all pending traces to configured exporters and the PostHog SDK.
 * Call at the end of request handling in serverless environments.
 */
export async function flushTracing(): Promise<void> {
  const flushes: Array<Promise<unknown>> = processors.map((p) =>
    p.forceFlush()
  );
  const posthog = getPostHogClient();
  if (posthog) flushes.push(posthog.flush());
  await Promise.all(flushes);
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
