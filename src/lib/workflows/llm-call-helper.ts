/**
 * Durable LLM-call helpers for Cloudflare Workflows.
 *
 *   - Take a `WorkflowStep` (from `cloudflare:workers`).
 *   - Use `step.do` for durable, retried units of work.
 *   - Throw `NonRetryableError` inside `step.do` bodies for unrecoverable
 *     errors so CF doesn't retry validation failures (the base class only
 *     re-wraps at the runImpl boundary).
 */

import { getEnv } from '#env';
import { createAdapter } from '@/lib/ai/create-adapter';
import {
  extractRunError,
  formatRunErrorMessage,
  structuredOutputConfig,
} from '@/lib/ai/llm-client';
import type { TextModel } from '@/lib/ai/models';
import { getContextWindow } from '@/lib/ai/models.config';
import { extractStreamingStringField } from '@/lib/ai/stream-extract';
import { ZERO_MICROS } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import type { ScopedDb } from '@/lib/db/scoped';
import { getChatPrompt } from '@/lib/prompts';
import { getFramePromptChannel } from '@/lib/realtime';
import { chat } from '@tanstack/ai';
import type { WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { z } from 'zod';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'llm-call-helper']);

export type DurableLLMCallConfig<TSchema extends z.ZodType> = {
  name: string;
  phase: { number: number; name: string };
  promptName: string;
  promptVariables?: Record<string, string>;
  modelId: TextModel;
  responseSchema: TSchema;
  additionalMetadata?: Record<string, unknown>;
};

export type DurableLLMCallContext = {
  sequenceId?: string;
  userId?: string;
  /** Override OpenRouter API key (e.g. user-provided). Falls back to platform env key. */
  openRouterApiKey?: string;
  /** Scoped DB context for resolving team API keys + deducting credits. */
  scopedDb?: ScopedDb;
};

export type DurableStreamingLLMCallContext = DurableLLMCallContext & {
  framePromptStream?: {
    frameId: string;
    promptType: 'visual' | 'motion';
    flushIntervalMs?: number;
  };
};

/**
 * Execute a durable LLM call. Returns the validated parsed object.
 *
 * Step layout (deterministic names):
 *   1. `prepare-${name}` — fetch prompt from Langfuse
 *   2. `${name}` — LLM call (JSON-stringified result for step boundary)
 *   3. `deduct-llm-credits-${name}` — credit deduction (only if scopedDb passed)
 */
export async function durableLLMCallCf<TSchema extends z.ZodType>(
  step: WorkflowStep,
  config: DurableLLMCallConfig<TSchema>,
  callContext: DurableLLMCallContext
): Promise<z.infer<TSchema>> {
  const { name, phase, modelId } = config;
  const logName = `phase-${phase.number}-${name}`;
  const logTags = [name, `phase-${phase.number}`, 'analysis'];
  const logMetadata = {
    phase: phase.number,
    phaseName: phase.name,
    ...config.additionalMetadata,
  };

  // Step 1: Prepare — fetch the chat prompt. promptReference (Langfuse
  // ChatPromptClient) isn't Rpc.Serializable so we refetch inside the LLM
  // step rather than passing it through the boundary.
  const { messages } = await step.do(`prepare-${name}`, async () => {
    const { messages } = await getChatPrompt(
      config.promptName,
      config.promptVariables
    );
    return { messages };
  });

  // Step 2: Durable LLM call. JSON-stringifies the parsed object so CF's
  // Rpc.Serializable<T> check passes regardless of the Zod-inferred shape.
  const jsonText = await step.do(name, async (): Promise<string> => {
    const openRouterApiKeyInfo = callContext.scopedDb
      ? await callContext.scopedDb.apiKeys.resolveKey('openrouter')
      : (() => {
          const env = getEnv();
          if (!env.OPENROUTER_KEY) {
            throw new NonRetryableError(
              'No API key available for provider: openrouter',
              'WorkflowValidationError'
            );
          }
          return { key: env.OPENROUTER_KEY, source: 'platform' as const };
        })();
    const adapter = createAdapter(modelId, openRouterApiKeyInfo.key);

    // Refetch prompt inside the LLM step — promptReference can't cross the
    // step boundary (not Rpc.Serializable).
    const { prompt: promptReference } = await getChatPrompt(
      config.promptName,
      config.promptVariables
    );

    logger.info(`[LLM:${logName}:cf] Starting call`, {
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

    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 300_000);
    const structured = structuredOutputConfig(
      config.modelId,
      config.responseSchema,
      systemPrompts
    );

    try {
      const text = await chat({
        adapter,
        messages: chatMessages,
        systemPrompts: structured.systemPrompts,
        stream: false,
        maxTokens: Math.floor(getContextWindow(config.modelId) * 0.5),
        abortController,
        metadata: {
          observationName: logName,
          prompt: promptReference,
          tags: logTags,
          metadata: logMetadata,
          sessionId: callContext.sequenceId,
          userId: callContext.userId,
        },
        modelOptions: { responseFormat: structured.responseFormat },
        debug: false,
      });
      logger.info(`[LLM:${logName}:cf] Call succeeded`);
      // Return as JSON string — round-trips through step.do without hitting
      // CF's Rpc.Serializable constraint on the Zod-inferred shape.
      return text;
    } finally {
      clearTimeout(timeout);
    }
  });

  if (callContext.scopedDb) {
    const scopedDb = callContext.scopedDb;
    await step.do(`deduct-llm-credits-${name}`, async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: ZERO_MICROS,
        usedOwnKey: !!callContext.openRouterApiKey,
        description: `LLM analysis (${modelId})`,
        metadata: {
          model: modelId,
          phase: phase.number,
          phaseName: phase.name,
          stepName: name,
          sequenceId: callContext.sequenceId,
        },
      });
    });
  }

  return config.responseSchema.parse(JSON.parse(jsonText));
}

/**
 * Streaming variant of {@link durableLLMCallCf}. Same semantics as the QStash
 * `durableStreamingLLMCall`: degrades to the non-streaming path when
 * `framePromptStream` is omitted, so script-analysis flows that share these
 * workflows don't burn realtime publishes nobody is listening to.
 */
export async function durableStreamingLLMCallCf<TSchema extends z.ZodType>(
  step: WorkflowStep,
  config: DurableLLMCallConfig<TSchema>,
  callContext: DurableStreamingLLMCallContext
): Promise<z.infer<TSchema>> {
  if (!callContext.framePromptStream) {
    return durableLLMCallCf(step, config, callContext);
  }

  const { name, phase, modelId } = config;
  const {
    frameId,
    promptType,
    flushIntervalMs = 80,
  } = callContext.framePromptStream;
  const logName = `phase-${phase.number}-${name}`;
  const logTags = [name, `phase-${phase.number}`, 'analysis', 'stream'];
  const logMetadata = {
    phase: phase.number,
    phaseName: phase.name,
    ...config.additionalMetadata,
  };

  const { messages } = await step.do(`prepare-${name}`, async () => {
    const { messages } = await getChatPrompt(
      config.promptName,
      config.promptVariables
    );
    return { messages };
  });

  const jsonText = await step.do(
    `${name}-stream`,
    async (): Promise<string> => {
      const openRouterApiKeyInfo = callContext.scopedDb
        ? await callContext.scopedDb.apiKeys.resolveKey('openrouter')
        : (() => {
            const env = getEnv();
            if (!env.OPENROUTER_KEY) {
              throw new NonRetryableError(
                'No API key available for provider: openrouter',
                'WorkflowValidationError'
              );
            }
            return { key: env.OPENROUTER_KEY, source: 'platform' as const };
          })();
      const adapter = createAdapter(modelId, openRouterApiKeyInfo.key);
      const { prompt: promptReference } = await getChatPrompt(
        config.promptName,
        config.promptVariables
      );

      logger.info(`[LLM:${logName}:cf] Starting streaming call`, {
        model: modelId,
        keySource: openRouterApiKeyInfo.source,
        messageCount: messages.length,
        frameId,
        promptType,
      });

      const systemPrompts: string[] = [];
      const chatMessages: Array<{
        role: 'user' | 'assistant';
        content: string;
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

      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 300_000);
      const structured = structuredOutputConfig(
        config.modelId,
        config.responseSchema,
        systemPrompts
      );

      const channel = getFramePromptChannel(frameId);
      let accumulated = '';
      let lastExtracted = '';
      let pendingDelta = '';
      let lastEmitAt = 0;

      const flushDelta = async () => {
        if (!pendingDelta) return;
        const delta = pendingDelta;
        pendingDelta = '';
        lastEmitAt = Date.now();
        await channel.emit('framePrompt.streaming', { promptType, delta });
      };

      try {
        for await (const event of chat({
          adapter,
          messages: chatMessages,
          systemPrompts: structured.systemPrompts,
          stream: true,
          maxTokens: Math.floor(getContextWindow(config.modelId) * 0.5),
          abortController,
          metadata: {
            observationName: logName,
            prompt: promptReference,
            tags: logTags,
            metadata: logMetadata,
            sessionId: callContext.sequenceId,
            userId: callContext.userId,
          },
          modelOptions: { responseFormat: structured.responseFormat },
          debug: false,
        })) {
          if (
            event.type === 'TEXT_MESSAGE_CONTENT' &&
            typeof event.delta === 'string'
          ) {
            accumulated += event.delta;
            const next = extractStreamingStringField(accumulated, 'fullPrompt');
            if (next.length > lastExtracted.length) {
              pendingDelta += next.slice(lastExtracted.length);
              lastExtracted = next;
            }
            if (pendingDelta && Date.now() - lastEmitAt >= flushIntervalMs) {
              await flushDelta();
            }
            continue;
          }
          const runError = extractRunError(event);
          if (runError) {
            logger.error(`[LLM:${logName}:cf] Streaming call RUN_ERROR`, {
              runError: runError.event,
            });
            throw new Error(formatRunErrorMessage(runError));
          }
        }
        await flushDelta();
        logger.info(`[LLM:${logName}:cf] Streaming call succeeded`);
        return accumulated;
      } finally {
        clearTimeout(timeout);
      }
    }
  );

  if (callContext.scopedDb) {
    const scopedDb = callContext.scopedDb;
    await step.do(`deduct-llm-credits-${name}`, async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: ZERO_MICROS,
        usedOwnKey: !!callContext.openRouterApiKey,
        description: `LLM analysis (${modelId})`,
        metadata: {
          model: modelId,
          phase: phase.number,
          phaseName: phase.name,
          stepName: name,
          sequenceId: callContext.sequenceId,
        },
      });
    });
  }

  return config.responseSchema.parse(JSON.parse(jsonText));
}
