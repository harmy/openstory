/**
 * Visual Prompt Generation Workflow
 *
 * Generates visual prompts for scenes based on character bible and style config.
 * Uses three-step durable pattern: prepare → context.call → log
 */

import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { VisualPromptSceneWorkflowInput } from '@/lib/workflow/types';
import { computeVisualPromptInputHash } from '../ai/input-hash';
import { narrowFramePromptContext } from '../ai/prompt-context';
import {
  type VisualPromptWithContinuity,
  visualPromptWithContinuitySchema,
} from '../ai/scene-analysis.schema';
import { getGenerationChannel } from '../realtime';
import { durableLLMCall } from './llm-call-helper';

export const visualPromptSceneWorkflow = createScopedWorkflow<
  VisualPromptSceneWorkflowInput,
  { sceneId: string } & VisualPromptWithContinuity
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
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
    } = input;

    const result = await durableLLMCall(
      context,
      {
        name: 'visual-prompts',
        phase: { number: 3, name: 'Writing image prompts…' },

        promptName: 'phase/visual-prompt-scene-generation-chat',
        promptVariables: {
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
        },

        modelId: analysisModelId,
        responseSchema: visualPromptWithContinuitySchema,

        additionalMetadata: {
          frameId,
        },
      },
      {
        sequenceId,
        scopedDb,
      }
    );

    if (sequenceId && frameId) {
      if (!result.visual.fullPrompt) {
        throw new Error(
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

      await context.run('save-visual-prompt-to-db', async () => {
        const previous = await scopedDb.framePromptVariants.getLatest(
          frameId,
          'visual'
        );
        const source = previous ? 'regenerated' : 'ai-generated';

        await scopedDb.frames.update(frameId, { metadata: enrichedScene });

        await scopedDb.framePromptVariants.write({
          frameId,
          promptType: 'visual',
          text: result.visual.fullPrompt,
          components: result.visual.components ?? null,
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
      });
    }

    return { sceneId: scene.sceneId, ...result };
  },
  {
    failureFunction: async ({ context, failStatus, failResponse }) => {
      const error = sanitizeFailResponse(failResponse);
      console.error('[VisualPromptWorkflow] Failed', {
        workflowRunId: context.workflowRunId,
        failStatus,
        failResponse: error,
      });
      return `Visual prompt generation failed: ${error}`;
    },
  }
);
