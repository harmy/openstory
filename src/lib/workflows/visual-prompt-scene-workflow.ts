/**
 * Cloudflare Workflows port of `visualPromptSceneWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/visual-prompt-scene-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`.
 *   - Inlines the LLM call logic from `durableStreamingLLMCall` because that
 *     helper is bound to QStash's `WorkflowContext`. The step names match
 *     the helper's exactly (`prepare-visual-prompts`, `visual-prompts` or
 *     `visual-prompts-stream`, `deduct-llm-credits-visual-prompts`) so a
 *     side-by-side comparison stays trivial. */

import { createAdapter } from '@/lib/ai/create-adapter';
import { computeVisualPromptInputHash } from '@/lib/ai/input-hash';
import { getContextWindow } from '@/lib/ai/models.config';
import { narrowFramePromptContext } from '@/lib/ai/prompt-context';
import {
  type VisualPromptWithContinuity,
  visualPromptWithContinuitySchema,
} from '@/lib/ai/scene-analysis.schema';
import {
  extractRunError,
  formatRunErrorMessage,
  structuredOutputConfig,
} from '@/lib/ai/llm-client';
import { extractStreamingStringField } from '@/lib/ai/stream-extract';
import { ZERO_MICROS } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import type { ScopedDb } from '@/lib/db/scoped';
import { getChatPrompt } from '@/lib/prompts';
import { getFramePromptChannel, getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type { VisualPromptSceneWorkflowInput } from '@/lib/workflow/types';
import { chat } from '@tanstack/ai';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'visual-prompt-scene']);

type VisualPromptSceneResult = { sceneId: string } & VisualPromptWithContinuity;

const PHASE = { number: 3, name: 'Writing image prompts…' } as const;
const STEP_NAME = 'visual-prompts';
const LOG_NAME = `phase-${PHASE.number}-${STEP_NAME}`;
const LOG_TAGS = [STEP_NAME, `phase-${PHASE.number}`, 'analysis'] as const;
const LOG_TAGS_STREAM = [...LOG_TAGS, 'stream'] as const;

export class VisualPromptSceneWorkflow extends OpenStoryWorkflowEntrypoint<VisualPromptSceneWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<VisualPromptSceneWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<VisualPromptSceneResult> {
    const input = event.payload;
    const {
      scene,
      sceneBefore,
      sceneAfter,
      aspectRatio,
      characterBible,
      locationBible,
      elementBible = [],
      styleConfig,
      analysisModelId,
      frameId,
      sequenceId,
      userId,
      emitStreaming,
    } = input;

    const streamConfig =
      emitStreaming && frameId
        ? { frameId, promptType: 'visual' as const, flushIntervalMs: 80 }
        : undefined;

    const logMetadata = {
      phase: PHASE.number,
      phaseName: PHASE.name,
      frameId,
    };

    // Step 1: Prepare — fetch prompt from Langfuse.
    const { messages, promptReference } = await step.do(
      `prepare-${STEP_NAME}`,
      async () => {
        const { messages: msgs } = await getChatPrompt(
          'phase/visual-prompt-scene-generation-chat',
          {
            sceneBefore: sceneBefore
              ? JSON.stringify(sceneBefore, null, 2)
              : '(none)',
            sceneAfter: sceneAfter
              ? JSON.stringify(sceneAfter, null, 2)
              : '(none)',
            scene: JSON.stringify(scene, null, 2),
            characterBible: JSON.stringify(characterBible, null, 2),
            locationBible: JSON.stringify(locationBible, null, 2),
            elementBible: JSON.stringify(elementBible, null, 2),
            styleConfig: JSON.stringify(styleConfig, null, 2),
            aspectRatio,
          }
        );
        return { messages: msgs, promptReference: undefined };
      }
    );

    // Step 2: Durable LLM call (streaming or non-streaming depending on
    // whether `emitStreaming` was set by the caller). Step name matches
    // `durableStreamingLLMCall`'s exactly so trace parity holds.
    const llmStepName = streamConfig ? `${STEP_NAME}-stream` : STEP_NAME;

    // VisualPromptWithContinuity is a Zod-inferred object that doesn't
    // satisfy CF's `Rpc.Serializable<T>` constraint structurally (the
    // discriminated union members confuse the check), but is JSON-safe
    // at runtime. JSON-stringify around the step boundary so the type
    // round-trips through Serializable cleanly.
    const resultJson = await step.do(llmStepName, async (): Promise<string> => {
      const openRouterApiKeyInfo =
        await scopedDb.apiKeys.resolveKey('openrouter');
      const adapter = createAdapter(analysisModelId, openRouterApiKeyInfo.key);

      logger.info(
        `[VisualPromptSceneWorkflow:cf] [LLM:${LOG_NAME}] Starting${
          streamConfig ? ' streaming' : ''
        } call`,
        {
          model: analysisModelId,
          keySource: openRouterApiKeyInfo.source,
          messageCount: messages.length,
          ...(streamConfig
            ? {
                frameId: streamConfig.frameId,
                promptType: streamConfig.promptType,
              }
            : {}),
        }
      );

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
        analysisModelId,
        visualPromptWithContinuitySchema,
        systemPrompts
      );

      try {
        if (!streamConfig) {
          const text = await chat({
            adapter,
            messages: chatMessages,
            systemPrompts: structured.systemPrompts,
            stream: false,
            maxTokens: Math.floor(getContextWindow(analysisModelId) * 0.5),
            abortController,
            metadata: {
              observationName: LOG_NAME,
              prompt: promptReference,
              tags: [...LOG_TAGS],
              metadata: logMetadata,
              sessionId: sequenceId,
              userId,
            },
            modelOptions: { responseFormat: structured.responseFormat },
            debug: false,
          });
          logger.info(
            `[VisualPromptSceneWorkflow:cf] [LLM:${LOG_NAME}] Call succeeded`
          );
          return JSON.stringify(
            visualPromptWithContinuitySchema.parse(JSON.parse(text))
          );
        }

        // Streaming path — emit visible `fullPrompt` deltas while accumulating.
        const channel = getFramePromptChannel(streamConfig.frameId);
        let accumulated = '';
        let lastExtracted = '';
        let pendingDelta = '';
        let lastEmitAt = 0;

        const flushDelta = async () => {
          if (!pendingDelta) return;
          const delta = pendingDelta;
          pendingDelta = '';
          lastEmitAt = Date.now();
          await channel.emit('framePrompt.streaming', {
            promptType: streamConfig.promptType,
            delta,
          });
        };

        for await (const streamEvent of chat({
          adapter,
          messages: chatMessages,
          systemPrompts: structured.systemPrompts,
          stream: true,
          maxTokens: Math.floor(getContextWindow(analysisModelId) * 0.5),
          abortController,
          metadata: {
            observationName: LOG_NAME,
            prompt: promptReference,
            tags: [...LOG_TAGS_STREAM],
            metadata: logMetadata,
            sessionId: sequenceId,
            userId,
          },
          modelOptions: { responseFormat: structured.responseFormat },
          debug: false,
        })) {
          if (
            streamEvent.type === 'TEXT_MESSAGE_CONTENT' &&
            typeof streamEvent.delta === 'string'
          ) {
            accumulated += streamEvent.delta;
            const next = extractStreamingStringField(accumulated, 'fullPrompt');
            if (next.length > lastExtracted.length) {
              pendingDelta += next.slice(lastExtracted.length);
              lastExtracted = next;
            }
            if (
              pendingDelta &&
              Date.now() - lastEmitAt >= streamConfig.flushIntervalMs
            ) {
              await flushDelta();
            }
            continue;
          }
          const runError = extractRunError(streamEvent);
          if (runError) {
            logger.error(
              `[VisualPromptSceneWorkflow:cf] [LLM:${LOG_NAME}] Streaming call RUN_ERROR`,
              { runError: runError.event }
            );
            throw new Error(formatRunErrorMessage(runError));
          }
        }
        await flushDelta();
        logger.info(
          `[VisualPromptSceneWorkflow:cf] [LLM:${LOG_NAME}] Streaming call succeeded`
        );
        return JSON.stringify(
          visualPromptWithContinuitySchema.parse(JSON.parse(accumulated))
        );
      } finally {
        clearTimeout(timeout);
      }
    });
    const result: VisualPromptWithContinuity =
      visualPromptWithContinuitySchema.parse(JSON.parse(resultJson));

    // Step 3: Deduct LLM credits.
    await step.do(`deduct-llm-credits-${STEP_NAME}`, async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: ZERO_MICROS,
        usedOwnKey: false,
        description: `LLM analysis (${analysisModelId})`,
        metadata: {
          model: analysisModelId,
          phase: PHASE.number,
          phaseName: PHASE.name,
          stepName: STEP_NAME,
          sequenceId,
        },
      });
    });

    if (sequenceId && frameId) {
      if (!result.visual.fullPrompt) {
        throw new WorkflowValidationError(
          `Visual prompt generation returned empty fullPrompt for scene ${scene.sceneId}`
        );
      }

      const enrichedScene = {
        ...scene,
        prompts: {
          ...scene.prompts,
          visual: result.visual,
        },
        continuity: result.continuity,
      };

      // Hash inputs are narrowed by the LLM's continuity output so unreferenced
      // characters / elements / locations elsewhere in the sequence don't flip
      // this frame's hash later.
      const narrowed = narrowFramePromptContext({
        scene: enrichedScene,
        styleConfig,
        characterBible,
        locationBible,
        elementBible,
        aspectRatio,
        analysisModel: analysisModelId,
      });
      const inputHash = await computeVisualPromptInputHash(narrowed);

      await step.do('save-visual-prompt-to-db', async () => {
        const previous = await scopedDb.framePromptVariants.getLatest(
          frameId,
          'visual'
        );
        const source = previous ? 'regenerated' : 'ai-generated';

        // Clear `frame.imagePrompt` user-override when regenerating. The
        // override would otherwise mask the freshly regenerated prompt in
        // every downstream read (effective-prompt fallback chain), so a
        // regen-prompt click on a previously user-edited frame would do
        // nothing visible. The variant row above preserves the new prompt;
        // the user's prior override is still in the prompt-history sheet
        // and can be restored from there.
        await scopedDb.frames.update(frameId, {
          metadata: enrichedScene,
          imagePrompt: null,
        });

        await scopedDb.framePromptVariants.write({
          frameId,
          promptType: 'visual',
          text: result.visual.fullPrompt,
          components: result.visual.components,
          source,
          inputHash,
          analysisModel: analysisModelId,
        });

        await getGenerationChannel(sequenceId).emit(
          'generation.frame:updated',
          {
            frameId,
            updateType: 'visual-prompt',
            metadata: enrichedScene,
          }
        );

        // Signal end-of-stream to the per-frame channel so the UI can swap
        // out the streamed-deltas buffer for the persisted prompt.
        if (emitStreaming) {
          await getFramePromptChannel(frameId).emit('framePrompt.completed', {
            promptType: 'visual',
          });
        }
      });
    }

    return { sceneId: scene.sceneId, ...result };
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<VisualPromptSceneWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const payload = event.payload;
    logger.error('[VisualPromptSceneWorkflow:cf] Failed', {
      workflowRunId: event.instanceId,
      error,
    });
    // Surface the failure on the per-frame channel so an actively-viewing
    // client can clear its streaming state and toast. Best-effort.
    try {
      if (payload.emitStreaming && payload.frameId) {
        await getFramePromptChannel(payload.frameId).emit(
          'framePrompt.failed',
          { promptType: 'visual', error }
        );
      }
    } catch (emitErr) {
      logger.warn('[VisualPromptSceneWorkflow:cf] failed to emit failure', {
        err: emitErr,
      });
    }
  }
}
