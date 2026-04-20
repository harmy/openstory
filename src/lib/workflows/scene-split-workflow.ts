/**
 * Scene Split Workflow
 * Streaming scene split with progressive frame creation.
 *
 * Steps:
 * 1. prepare-scene-splitting — fetch prompt from Langfuse
 * 2. scene-splitting-stream — stream LLM response, create frames progressively
 * 3. reconcile-frames — ensure all frames exist (handles cached result replay)
 * 4. deduct-llm-credits-scene-splitting — deduct credits, emit phase complete
 */

import { callLLMStream } from '@/lib/ai/llm-client';
import { getContextWindow } from '@/lib/ai/models.config';
import { sceneSplittingResultSchema } from '@/lib/ai/response-schemas';
import {
  createStreamingSceneParser,
  type SceneSplittingScene,
  stripCodeFences,
} from '@/lib/ai/streaming-scene-parser';
import { parse } from 'partial-json';
import { ZERO_MICROS } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import type { NewFrame } from '@/lib/db/schema';
import { getChatPrompt } from '@/lib/prompts';
import { getGenerationChannel } from '@/lib/realtime';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  ImageWorkflowInput,
  SceneSplitWorkflowInput,
  SceneSplitWorkflowResult,
} from '@/lib/workflow/types';
import { PREVIEW_IMAGE_MODEL } from '../ai/models';
import { aspectRatioToImageSize } from '../constants/aspect-ratios';
import { buildPreviewPrompt } from '../prompts/poster-prompt';
import { triggerWorkflow } from '../workflow/client';
import { buildWorkflowLabel } from '../workflow/labels';

export const sceneSplitWorkflow = createScopedWorkflow<
  SceneSplitWorkflowInput,
  SceneSplitWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const { sequenceId, modelId, styleConfig, aspectRatio } = input;

    const phase = { number: 1, name: 'Analyzing script\u2026' };
    const name = 'scene-splitting';
    const logName = `phase-${phase.number}-${name}`;
    const logTags = [name, `phase-${phase.number}`, 'analysis'];
    const logMetadata = { phase: phase.number, phaseName: phase.name };

    // Step 1: Prepare — fetch prompt
    const { messages, promptReference } = await context.run(
      'prepare-scene-splitting',
      async () => {
        const promptVariables = {
          aspectRatio,
          script: input.script,
        };
        const { prompt, messages } = await getChatPrompt(
          input.promptName,
          promptVariables
        );

        return { messages, promptReference: prompt };
      }
    );

    // Step 2: Stream LLM response, create frames as scenes arrive
    const streamResult = await context.run(
      'scene-splitting-stream',
      async () => {
        const openRouterApiKeyInfo =
          await scopedDb.apiKeys.resolveKey('openrouter');

        console.log(`[LLM:${logName}] Starting streaming call`, {
          model: modelId,
          keySource: openRouterApiKeyInfo.source,
          messageCount: messages.length,
        });

        const parser = createStreamingSceneParser();
        const frameMapping: Array<{ sceneId: string; frameId: string }> = [];
        let finalText = '';
        let chunkCount = 0;
        let prevScene: SceneSplittingScene | undefined = undefined;
        let prevFrameId: string | undefined = undefined;
        // Stream the LLM response
        for await (const chunk of callLLMStream({
          model: modelId,
          messages: messages,
          max_tokens: Math.floor(getContextWindow(modelId) * 0.65),
          responseSchema: sceneSplittingResultSchema,
          apiKey: openRouterApiKeyInfo.key,
          observationName: logName,
          prompt: promptReference,
          tags: logTags,
          metadata: logMetadata,
        })) {
          chunkCount++;
          finalText = chunk.accumulated;
          const events = parser.feed(chunk.accumulated);

          if (chunkCount % 20 === 0) {
            console.log(
              `[Stream:${logName}] chunk #${chunkCount} | ${finalText.length} chars | ${frameMapping.length} frames so far`
            );
          }

          for (const event of events) {
            if (event.type === 'title' && sequenceId) {
              console.log(
                `[Stream:${logName}] Title detected: "${event.title}" (chunk #${chunkCount})`
              );
              await scopedDb.sequences.updateTitle(sequenceId, event.title);
              await getGenerationChannel(sequenceId).emit(
                'generation.updated',
                { title: event.title }
              );
            }

            if (event.type === 'characterBible' && sequenceId) {
              console.log(
                `[Stream:${logName}] Character bible detected (${event.bible.length} entries), advancing to phase 2`
              );
              await getGenerationChannel(sequenceId).emit(
                'generation.phase:start',
                {
                  phase: 2,
                  phaseName: 'Casting characters & locations\u2026',
                }
              );
            }

            if (event.type === 'scene:updated') {
              console.log(
                // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                `[Stream:${logName}] Scene ${event.index + 1} title updated: "${event.scene.metadata?.title}" (chunk #${chunkCount})`
              );

              if (sequenceId) {
                await scopedDb.frames.upsert({
                  sequenceId,
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  description: event.scene.originalScript?.extract || '',
                  orderIndex: event.index,
                  metadata: event.scene,
                  durationMs: Math.round(
                    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                    (event.scene.metadata?.durationSeconds || 3) * 1000
                  ),
                  thumbnailStatus: 'generating',
                  videoStatus: 'pending',
                } satisfies NewFrame);
              }

              await getGenerationChannel(sequenceId).emit(
                'generation.scene:updated',
                {
                  sceneId: event.scene.sceneId,
                  sceneNumber: event.scene.sceneNumber,
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  title: event.scene.metadata?.title || 'Untitled Scene',
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  scriptExtract: event.scene.originalScript?.extract || '',
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  durationSeconds: event.scene.metadata?.durationSeconds || 3,
                }
              );
            }

            if (event.type === 'scene') {
              console.log(
                // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                `[Stream:${logName}] Scene ${event.index + 1} complete: "${event.scene.metadata?.title}" (chunk #${chunkCount}, ${finalText.length} chars)`
              );

              await getGenerationChannel(sequenceId).emit(
                'generation.scene:new',
                {
                  sceneId: event.scene.sceneId,
                  sceneNumber: event.scene.sceneNumber,
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  title: event.scene.metadata?.title || 'Untitled Scene',
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  scriptExtract: event.scene.originalScript?.extract || '',
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  durationSeconds: event.scene.metadata?.durationSeconds || 3,
                }
              );

              if (sequenceId) {
                const frame = await scopedDb.frames.upsert({
                  sequenceId,
                  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                  description: event.scene.originalScript?.extract || '',
                  orderIndex: event.index,
                  metadata: event.scene,
                  durationMs: Math.round(
                    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
                    (event.scene.metadata?.durationSeconds || 3) * 1000
                  ),
                  thumbnailStatus: 'generating',
                  videoStatus: 'pending',
                } satisfies NewFrame);

                console.log(
                  `[Stream:${logName}] Frame created: ${frame.id} for scene "${event.scene.sceneId}"`
                );

                frameMapping.push({
                  sceneId: event.scene.sceneId,
                  frameId: frame.id,
                });

                await getGenerationChannel(sequenceId).emit(
                  'generation.frame:created',
                  {
                    frameId: frame.id,
                    sceneId: event.scene.sceneId,
                    orderIndex: event.index,
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

                  // Now kick off the preview generation for the previous scene
                  // Just trigger a workflow - don't await it
                  // Do this instead of context.invoke because we don't want to block the main thread
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
              // Set previous scene to the current scene
              prevScene = event.scene;
            }
          }
        }

        // Trigger preview for the last scene (the loop only triggers N-1)
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

        // Parse final accumulated text with full schema (use partial-json
        // so a truncated stream doesn't crash — Zod still validates the shape)
        const parsed = sceneSplittingResultSchema.parse(
          parse(stripCodeFences(finalText))
        );
        console.log(
          `[Stream:${logName}] Complete | ${chunkCount} chunks | ${parsed.scenes.length} scenes | ${finalText.length} chars`
        );

        return {
          scenes: parsed.scenes,
          projectMetadata: parsed.projectMetadata,
          frameMapping,
          characterBible: parsed.characterBible,
          locationBible: parsed.locationBible,
        };
      }
    );

    // Step 3: Reconcile — ensure all frames exist (handles QStash cached result replay)
    const { scenes, title, frameMapping, characterBible, locationBible } =
      await context.run('reconcile-frames', async () => {
        const { scenes, projectMetadata } = streamResult;
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        const resolvedTitle = projectMetadata?.title || 'Untitled';

        if (!sequenceId) {
          return {
            scenes,
            title: resolvedTitle,
            frameMapping: streamResult.frameMapping,
            characterBible: streamResult.characterBible,
            locationBible: streamResult.locationBible,
          };
        }

        // Bulk upsert all frames to catch any missed during streaming
        // (e.g., QStash replays a cached step 2 result without re-firing side effects)
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
        // until storyboard-workflow completes all phases)
        await scopedDb.sequences.updateTitle(sequenceId, resolvedTitle);
        await scopedDb.sequences.updateWorkflow(
          sequenceId,
          'analyze-script-shorter-prompts-batch-size-1'
        );

        // Emit frame:created for any frames the streaming step didn't cover
        const streamedSceneIds = new Set(
          streamResult.frameMapping.map((f) => f.sceneId)
        );
        for (const { sceneId, frameId } of reconciledMapping) {
          if (!streamedSceneIds.has(sceneId)) {
            const scene = scenes.find((s) => s.sceneId === sceneId);
            await getGenerationChannel(sequenceId).emit(
              'generation.frame:created',
              {
                frameId,
                sceneId,
                orderIndex: scene?.sceneNumber ? scene.sceneNumber - 1 : 0,
              }
            );
          }
        }

        return {
          scenes,
          title: resolvedTitle,
          frameMapping: reconciledMapping,
          characterBible: streamResult.characterBible,
          locationBible: streamResult.locationBible,
        };
      });

    // Step 4: Deduct credits
    const openRouterKeyInfo = await scopedDb.apiKeys.resolveKey('openrouter');
    await context.run('deduct-llm-credits-scene-splitting', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: ZERO_MICROS,
        usedOwnKey: openRouterKeyInfo.source === 'team',
        description: `LLM analysis (${modelId})`,
        metadata: {
          model: modelId,
          phase: phase.number,
          phaseName: phase.name,
          stepName: name,
          sequenceId,
        },
      });
    });

    return { scenes, title, frameMapping, characterBible, locationBible };
  },
  {
    failureFunction: async ({ context, failResponse }) => {
      const { sequenceId } = context.requestPayload;
      if (!sequenceId) return;

      console.error('[SceneSplitWorkflow] Failure:', failResponse);
      await getGenerationChannel(sequenceId).emit('generation.error', {
        message: 'Scene splitting failed',
      });

      return `Scene split workflow failed: ${failResponse}`;
    },
  }
);
