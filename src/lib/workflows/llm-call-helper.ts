/**
 * Durable LLM Call Helper
 * Encapsulates the 3-step pattern: prepare -> call -> log
 * Uses @tanstack/ai-openrouter adapters instead of context.api.openai.call
 */

import { getEnv } from '#env';
import { createAdapter } from '@/lib/ai/create-adapter';
import type { TextModel } from '@/lib/ai/models';
import { getContextWindow } from '@/lib/ai/models.config';
import { ZERO_MICROS } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import type { ScopedDb } from '@/lib/db/scoped';
import { getChatPrompt } from '@/lib/prompts';
import { chat, convertSchemaToJsonSchema } from '@tanstack/ai';
import type { WorkflowContext } from '@upstash/workflow';
import { z } from 'zod';

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
  /** Override OpenRouter API key (e.g., user-provided key). Falls back to platform env key. */
  openRouterApiKey?: string;
  /** Scoped DB context for resolving team API keys and deducting credits. Falls back to env key when absent. */
  scopedDb?: ScopedDb;
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
export async function durableLLMCall<TInput, TSchema extends z.ZodType>(
  context: WorkflowContext<TInput>,
  config: DurableLLMCallConfig<TSchema>,
  callContext: DurableLLMCallContext
) {
  const { name, phase, modelId } = config;
  const logName = `phase-${phase.number}-${name}`;
  const logTags = [name, `phase-${phase.number}`, 'analysis'];
  const logMetadata = {
    phase: phase.number,
    phaseName: phase.name,
    ...config.additionalMetadata,
  };

  // Step 1: Prepare -- fetch prompt
  const { messages, promptReference } = await context.run(
    `prepare-${name}`,
    async () => {
      const { messages } = await getChatPrompt(
        config.promptName,
        config.promptVariables
      );

      return { messages, promptReference: undefined };
    }
  );

  // Step 2: Durable LLM call (QStash retries step delivery on failure)
  const jsonResponse = await context.run(name, async () => {
    const openRouterApiKeyInfo = callContext.scopedDb
      ? await callContext.scopedDb.apiKeys.resolveKey('openrouter')
      : (() => {
          const env = getEnv();
          if (!env.OPENROUTER_KEY)
            throw new Error('No API key available for provider: openrouter');
          return { key: env.OPENROUTER_KEY, source: 'platform' as const };
        })();
    const adapter = createAdapter(modelId, openRouterApiKeyInfo.key);

    console.log(`[LLM:${logName}] Starting call`, {
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

    // Abort after 5 minutes to prevent indefinite hangs on unresponsive LLM providers
    const abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), 300_000);

    // Pass the schema via modelOptions.responseFormat (not chat()'s outputSchema).
    // outputSchema triggers @tanstack/ai's agentic-loop pre-pass, which fires a
    // separate streaming chatStream call before the structured-output call —
    // both share the same userMessage, so aimock's recorder collapses them onto
    // one fixture and the schema-constrained call never reaches the upstream.
    const strictSchema = convertSchemaToJsonSchema(config.responseSchema, {
      forStructuredOutput: true,
    });

    try {
      const text = await chat({
        adapter,
        messages: chatMessages,
        systemPrompts,
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
        modelOptions: {
          responseFormat: {
            type: 'json_schema',
            jsonSchema: {
              name: 'structured_output',
              schema: strictSchema,
              strict: true,
            },
          },
        },
        debug: true,
      });

      console.log(`[LLM:${logName}] Call succeeded`);
      return JSON.parse(text);
    } finally {
      clearTimeout(timeout);
    }
  });

  // Deduct LLM credits (cost tracked via Langfuse; adapter doesn't expose per-call usage)
  if (callContext.scopedDb) {
    await context.run(`deduct-llm-credits-${name}`, async () => {
      await deductWorkflowCredits({
        scopedDb: callContext.scopedDb,
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

  return config.responseSchema.parse(jsonResponse);
}
