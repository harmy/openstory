/**
 * Cloudflare Workflows port of `sceneSplitWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/scene-split-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * Differences (all infrastructure-level, not behavioural):
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `cf/base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload`.
 *   - Gap C: the streaming LLM call + per-chunk DB writes + per-chunk
 *     `generation.scene:*` event emissions + per-chunk preview-image
 *     fire-and-forget trigger all run inline inside a single top-level
 *     `step.do('scene-splitting-stream', …)`. If that step fails partway,
 *     the engine replays the entire LLM call — acceptable per the
 *     investigation (`docs/investigations/cloudflare-workflows.md` §Gap C).
 *   - The final value returned from `scene-splitting-stream` is Zod-inferred
 *     and structurally rejected by CF's `Rpc.Serializable<T>` check, so we
 *     JSON-stringify around the step boundary (same pattern as
 *     `visual-prompt-scene-workflow.ts`).
 *
 * The QStash version stays as-is — both run side by side until
 * `engine-registry.ts` flips `scene-split` to `'cloudflare'`. See
 * docs/investigations/cloudflare-workflows-poc.md.
 */

import { callLLMStream } from '@/lib/ai/llm-client';
import { PREVIEW_IMAGE_MODEL } from '@/lib/ai/models';
import { getContextWindow } from '@/lib/ai/models.config';
import {
  type SceneSplittingResult,
  sceneSplittingResultSchema,
} from '@/lib/ai/response-schemas';
import {
  createStreamingSceneParser,
  type SceneSplittingScene,
} from '@/lib/ai/streaming-scene-parser';
import { ZERO_MICROS } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { NewFrame } from '@/lib/db/schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { getChatPrompt } from '@/lib/prompts';
import { buildPreviewPrompt } from '@/lib/prompts/poster-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/cf/base-workflow';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import {
  isOpenRouterAuthError,
  sanitizeFailResponse,
} from '@/lib/workflow/sanitize-fail-response';
import type {
  ImageWorkflowInput,
  SceneSplitWorkflowInput,
  SceneSplitWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const PHASE = { number: 1, name: 'Analyzing script…' } as const;
const STEP_NAME = 'scene-splitting';
const LOG_NAME = `phase-${PHASE.number}-${STEP_NAME}`;
const LOG_TAGS = [STEP_NAME, `phase-${PHASE.number}`, 'analysis'];
const LOG_METADATA = { phase: PHASE.number, phaseName: PHASE.name };

/**
 * Shape produced by the streaming step (post JSON round-trip). Mirrors the
 * QStash `streamResult` value — note `projectMetadata` is preserved so the
 * reconcile step can extract the title, and `frameMapping` reflects only the
 * frames written inline during streaming.
 */
type StreamResult = {
  scenes: SceneSplittingResult['scenes'];
  projectMetadata: SceneSplittingResult['projectMetadata'];
  frameMapping: Array<{ sceneId: string; frameId: string }>;
  characterBible: SceneSplittingResult['characterBible'];
  locationBible: SceneSplittingResult['locationBible'];
  elementBible: SceneSplittingResult['elementBible'];
};

export class SceneSplitWorkflow extends OpenStoryWorkflowEntrypoint<SceneSplitWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<SceneSplitWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<SceneSplitWorkflowResult> {
    const input = event.payload;
    const {
      sequenceId,
      modelId,
      styleConfig,
      aspectRatio,
      elements = [],
    } = input;

    // Gap C: this single `step.do` owns the prompt fetch + the entire
    // streaming session. Inside, the partial-JSON parser, per-chunk DB writes
    // (upsertFrame), per-chunk realtime event emissions
    // (`generation.scene:new`, `generation.frame:created`,
    // `generation.scene:updated`, `generation.updated`,
    // `generation.phase:start`) and per-chunk fire-and-forget preview-image
    // triggers all run inline. On step failure the engine replays the whole
    // stream — acceptable per the investigation. The prompt fetch is folded
    // in because the Langfuse `ChatPromptClient` reference is not
    // `Rpc.Serializable<T>` and so can't cross a step boundary; keeping it
    // local also means the per-chunk side effects share the same retry
    // boundary as the LLM call that produced them. JSON-stringify the final
    // value around the boundary so the Zod-inferred result survives CF's
    // `Rpc.Serializable<T>` typecheck.
    const streamResultJson = await step.do(
      'scene-splitting-stream',
      async (): Promise<string> => {
        const elementsBlock =
          elements.length > 0
            ? elements
                .map((el) => {
                  // analyzeScriptWorkflow refuses to start while any element
                  // is pending/analyzing, so a null description here means
                  // vision genuinely failed for this row.
                  const desc = el.description
                    ? `: ${el.description}`
                    : ' (no visual reference available)';
                  return `- ${el.token}${desc}`;
                })
                .join('\n')
            : '(none)';
        const { prompt: promptReference, messages } = await getChatPrompt(
          input.promptName,
          {
            aspectRatio,
            script: input.script,
            elements: elementsBlock,
          }
        );

        const openRouterApiKeyInfo =
          await scopedDb.apiKeys.resolveKey('openrouter');

        console.log(
          `[SceneSplitWorkflow:cf] [LLM:${LOG_NAME}] Starting streaming call`,
          {
            model: modelId,
            keySource: openRouterApiKeyInfo.source,
            messageCount: messages.length,
          }
        );

        const parser = createStreamingSceneParser();
        const frameMapping: Array<{ sceneId: string; frameId: string }> = [];
        let finalText = '';
        let chunkCount = 0;
        let prevScene: SceneSplittingScene | undefined = undefined;
        let prevFrameId: string | undefined = undefined;
        let parsedResult: SceneSplittingResult | undefined;

        for await (const chunk of callLLMStream<SceneSplittingResult>({
          model: modelId,
          messages,
          max_tokens: Math.floor(getContextWindow(modelId) * 0.65),
          responseSchema: sceneSplittingResultSchema,
          apiKey: openRouterApiKeyInfo.key,
          observationName: LOG_NAME,
          prompt: promptReference,
          tags: LOG_TAGS,
          metadata: LOG_METADATA,
          userId: input.userId,
          sessionId: input.sequenceId,
        })) {
          if (chunk.done && chunk.parsed !== undefined) {
            parsedResult = chunk.parsed;
          }
          chunkCount++;
          finalText = chunk.accumulated;
          const events = parser.feed(chunk.accumulated);

          if (chunkCount % 20 === 0) {
            console.log(
              `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] chunk #${chunkCount} | ${finalText.length} chars | ${frameMapping.length} frames so far`
            );
          }

          for (const ev of events) {
            if (ev.type === 'title' && sequenceId) {
              console.log(
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Title detected: "${ev.title}" (chunk #${chunkCount})`
              );
              await scopedDb.sequences.updateTitle(sequenceId, ev.title);
              await getGenerationChannel(sequenceId).emit(
                'generation.updated',
                { title: ev.title }
              );
            }

            if (ev.type === 'characterBible' && sequenceId) {
              console.log(
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Character bible detected (${ev.bible.length} entries), advancing to phase 2`
              );
              await getGenerationChannel(sequenceId).emit(
                'generation.phase:start',
                {
                  phase: 2,
                  phaseName: 'Casting characters & locations…',
                }
              );
            }

            if (ev.type === 'scene:updated') {
              console.log(
                // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Scene ${ev.index + 1} title updated: "${ev.scene.metadata?.title}" (chunk #${chunkCount})`
              );

              if (sequenceId) {
                await scopedDb.frames.upsert({
                  sequenceId,
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  description: ev.scene.originalScript?.extract || '',
                  orderIndex: ev.index,
                  metadata: ev.scene,
                  durationMs: Math.round(
                    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                    (ev.scene.metadata?.durationSeconds || 3) * 1000
                  ),
                  thumbnailStatus: 'generating',
                  videoStatus: 'pending',
                } satisfies NewFrame);
              }

              await getGenerationChannel(sequenceId).emit(
                'generation.scene:updated',
                {
                  sceneId: ev.scene.sceneId,
                  sceneNumber: ev.scene.sceneNumber,
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  title: ev.scene.metadata?.title || 'Untitled Scene',
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  scriptExtract: ev.scene.originalScript?.extract || '',
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  durationSeconds: ev.scene.metadata?.durationSeconds || 3,
                }
              );
            }

            if (ev.type === 'scene') {
              console.log(
                // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Scene ${ev.index + 1} complete: "${ev.scene.metadata?.title}" (chunk #${chunkCount}, ${finalText.length} chars)`
              );

              await getGenerationChannel(sequenceId).emit(
                'generation.scene:new',
                {
                  sceneId: ev.scene.sceneId,
                  sceneNumber: ev.scene.sceneNumber,
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  title: ev.scene.metadata?.title || 'Untitled Scene',
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  scriptExtract: ev.scene.originalScript?.extract || '',
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  durationSeconds: ev.scene.metadata?.durationSeconds || 3,
                }
              );

              if (sequenceId) {
                const frame = await scopedDb.frames.upsert({
                  sequenceId,
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  description: ev.scene.originalScript?.extract || '',
                  orderIndex: ev.index,
                  metadata: ev.scene,
                  durationMs: Math.round(
                    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                    (ev.scene.metadata?.durationSeconds || 3) * 1000
                  ),
                  thumbnailStatus: 'generating',
                  videoStatus: 'pending',
                } satisfies NewFrame);

                console.log(
                  `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Frame created: ${frame.id} for scene "${ev.scene.sceneId}"`
                );

                frameMapping.push({
                  sceneId: ev.scene.sceneId,
                  frameId: frame.id,
                });

                await getGenerationChannel(sequenceId).emit(
                  'generation.frame:created',
                  {
                    frameId: frame.id,
                    sceneId: ev.scene.sceneId,
                    orderIndex: ev.index,
                  }
                );
                if (prevScene && prevFrameId) {
                  const sceneText =
                    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                    prevScene.originalScript?.extract ??
                    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                    prevScene.metadata?.title ??
                    'A cinematic scene';
                  const prompt = buildPreviewPrompt(sceneText, styleConfig);

                  // Fire-and-forget preview-image trigger for the previous
                  // scene. Routed through `triggerWorkflow` so the engine
                  // registry picks whichever engine is configured for
                  // `/image` at runtime.
                  await triggerWorkflow(
                    '/image',
                    {
                      userId: input.userId,
                      teamId: input.teamId,
                      sequenceId,
                      prompt,
                      model: PREVIEW_IMAGE_MODEL,
                      imageSize: aspectRatioToImageSize(aspectRatio),
                      numImages: 1,
                      frameId: prevFrameId,
                      skipStorage: true,
                    } satisfies ImageWorkflowInput,
                    {
                      label: buildWorkflowLabel(sequenceId),
                    }
                  );
                }

                prevFrameId = frame.id;
              }
              prevScene = ev.scene;
            }
          }
        }

        // Trigger preview for the last scene (the loop only triggers N-1).
        if (prevScene && prevFrameId && sequenceId) {
          const sceneText =
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
            prevScene.originalScript?.extract ??
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
            prevScene.metadata?.title ??
            'A cinematic scene';
          const prompt = buildPreviewPrompt(sceneText, styleConfig);

          await triggerWorkflow(
            '/image',
            {
              userId: input.userId,
              teamId: input.teamId,
              sequenceId,
              prompt,
              model: PREVIEW_IMAGE_MODEL,
              imageSize: aspectRatioToImageSize(aspectRatio),
              numImages: 1,
              frameId: prevFrameId,
              skipStorage: true,
            } satisfies ImageWorkflowInput,
            {
              label: buildWorkflowLabel(sequenceId),
            }
          );
        }

        if (!parsedResult) {
          throw new NonRetryableError(
            `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Stream ended without a validated structured-output payload. ` +
              `chunks=${chunkCount} chars=${finalText.length} ` +
              `streamedScenes=${frameMapping.length} model=${modelId}. ` +
              `Likely cause: provider did not honor responseFormat:json_schema.`
          );
        }
        const parsed = parsedResult;
        console.log(
          `[SceneSplitWorkflow:cf] [Stream:${LOG_NAME}] Complete | ${chunkCount} chunks | ${parsed.scenes.length} scenes | ${finalText.length} chars`
        );

        // JSON round-trip: the inferred shape contains Zod discriminated
        // unions / catch-defaulted arrays that confuse CF's
        // `Rpc.Serializable<T>` typecheck. The value is JSON-clean at
        // runtime; stringify on the way out, parse on the way in.
        const streamResult: StreamResult = {
          scenes: parsed.scenes,
          projectMetadata: parsed.projectMetadata,
          frameMapping,
          characterBible: parsed.characterBible,
          locationBible: parsed.locationBible,
          elementBible: parsed.elementBible,
        };
        return JSON.stringify(streamResult);
      }
    );
    // Defensive shape check on replay — the data was Zod-validated once
    // inside the step, but if CF's step-cache persisted something corrupt
    // we fail loud here instead of silently downstream.
    const streamResult: StreamResult = JSON.parse(streamResultJson);
    if (
      !Array.isArray(streamResult.scenes) ||
      !Array.isArray(streamResult.frameMapping)
    ) {
      throw new NonRetryableError(
        'scene-splitting-stream returned a malformed result from cache',
        'WorkflowValidationError'
      );
    }

    // Step 3: Reconcile — ensure all frames exist (handles cached step replay).
    const reconcileJson = await step.do(
      'reconcile-frames',
      async (): Promise<string> => {
        const { scenes, projectMetadata } = streamResult;
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        const resolvedTitle = projectMetadata?.title || 'Untitled';

        if (!sequenceId) {
          return JSON.stringify({
            scenes,
            title: resolvedTitle,
            frameMapping: streamResult.frameMapping,
            characterBible: streamResult.characterBible,
            locationBible: streamResult.locationBible,
            elementBible: streamResult.elementBible,
          } satisfies SceneSplitWorkflowResult);
        }

        // Bulk upsert all frames to catch any missed during streaming
        // (e.g., a retry replays the streaming step's cached result without
        // re-firing its inline side effects).
        const frameInserts = scenes.map(
          (scene, index) =>
            ({
              sequenceId,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              description: scene.originalScript?.extract || '',
              orderIndex: index,
              metadata: scene,
              durationMs: Math.round(
                // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                (scene.metadata?.durationSeconds || 3) * 1000
              ),
              thumbnailStatus: 'generating',
              videoStatus: 'pending',
            }) satisfies NewFrame
        );

        const reconciledFrames = await scopedDb.frames.bulkUpsert(frameInserts);
        const reconciledMapping = reconciledFrames.map((f) => ({
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: metadata is JSONB, can be null despite Drizzle types
          sceneId: f.metadata?.sceneId || '',
          frameId: f.id,
        }));

        // Ensure title and workflow are set (status stays 'processing'
        // until storyboard-workflow completes all phases).
        await scopedDb.sequences.updateTitle(sequenceId, resolvedTitle);
        await scopedDb.sequences.updateWorkflow(
          sequenceId,
          'analyze-script-shorter-prompts-batch-size-1'
        );

        // Emit frame:created for any frames the streaming step didn't cover.
        const streamedSceneIds = new Set(
          streamResult.frameMapping.map((f) => f.sceneId)
        );
        for (const { sceneId: sId, frameId } of reconciledMapping) {
          if (!streamedSceneIds.has(sId)) {
            const scene = scenes.find((s) => s.sceneId === sId);
            await getGenerationChannel(sequenceId).emit(
              'generation.frame:created',
              {
                frameId,
                sceneId: sId,
                orderIndex: scene?.sceneNumber ? scene.sceneNumber - 1 : 0,
              }
            );
          }
        }

        return JSON.stringify({
          scenes,
          title: resolvedTitle,
          frameMapping: reconciledMapping,
          characterBible: streamResult.characterBible,
          locationBible: streamResult.locationBible,
          elementBible: streamResult.elementBible,
        } satisfies SceneSplitWorkflowResult);
      }
    );
    const reconciled: SceneSplitWorkflowResult = JSON.parse(reconcileJson);
    if (
      !Array.isArray(reconciled.scenes) ||
      !Array.isArray(reconciled.frameMapping)
    ) {
      throw new NonRetryableError(
        'reconcile-frames returned a malformed result from cache',
        'WorkflowValidationError'
      );
    }

    // Step 4: Reconcile element bible → update firstMention on existing rows.
    if (sequenceId && reconciled.elementBible.length > 0) {
      await step.do('reconcile-element-bible', async () => {
        for (const entry of reconciled.elementBible) {
          const existing = await scopedDb.sequenceElements.getByToken(
            sequenceId,
            entry.token
          );
          if (!existing) continue;
          await scopedDb.sequenceElements.updateFirstMention(existing.id, {
            sceneId: entry.firstMention.sceneId,
            text: entry.firstMention.text,
            lineNumber: entry.firstMention.lineNumber,
          });
        }
      });
    }

    // Step 5: Deduct credits.
    const openRouterKeyInfo = await scopedDb.apiKeys.resolveKey('openrouter');
    await step.do('deduct-llm-credits-scene-splitting', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: ZERO_MICROS,
        usedOwnKey: openRouterKeyInfo.source === 'team',
        description: `LLM analysis (${modelId})`,
        metadata: {
          model: modelId,
          phase: PHASE.number,
          phaseName: PHASE.name,
          stepName: STEP_NAME,
          sequenceId,
        },
      });
    });

    return reconciled;
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<SceneSplitWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const { sequenceId } = event.payload;
    console.error('[SceneSplitWorkflow:cf] Failure:', error);

    let userMessage = 'Scene splitting failed';
    if (
      isOpenRouterAuthError(error) &&
      (await scopedDb.apiKeys.hasKey('openrouter'))
    ) {
      await scopedDb.apiKeys.markKeyInvalid(
        'openrouter',
        sanitizeFailResponse(error)
      );
      userMessage =
        'Your OpenRouter API key is invalid — update it in Settings.';
    }

    if (sequenceId) {
      try {
        await getGenerationChannel(sequenceId).emit('generation.error', {
          message: userMessage,
        });
      } catch (emitError) {
        console.error(
          `[SceneSplitWorkflow:cf] Failed to emit failure event for sequence ${sequenceId}:`,
          emitError
        );
      }
    }
  }
}
