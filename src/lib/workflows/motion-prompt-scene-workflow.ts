/**
 * Motion Prompt Scene Workflow
 *
 * Generates motion prompts for a single scene based on character bible and style config.
 * Uses three-step durable pattern: prepare → context.call → log
 */

import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { MotionPromptSceneWorkflowInput } from '@/lib/workflow/types';
import { computeMotionPromptInputHash } from '../ai/input-hash';
import { narrowFramePromptContext } from '../ai/prompt-context';
import { getGenerationChannel } from '../realtime';
import {
  type MotionPrompt,
  motionPromptSchema,
} from '../ai/scene-analysis.schema';
import { durableLLMCall } from './llm-call-helper';

export const motionPromptSceneWorkflow = createScopedWorkflow<
  MotionPromptSceneWorkflowInput,
  { sceneId: string; motionPrompt: MotionPrompt }
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
      sequenceId,
      frameId,
    } = input;

    // ============================================================
    // PHASE 3: Motion Prompt Generation (using durableLLMCall helper)
    // ============================================================

    const { promptVariables, additionalMetadata } = await context.run(
      'prepare-motion-prompt-generation',
      async () => {
        console.log(
          `[MotionPromptSceneWorkflow] Generating motion prompt for scene ${scene.sceneId}`
        );
        return {
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
          additionalMetadata: {
            frameId,
          },
        };
      }
    );
    const motionPrompt = await durableLLMCall(
      context,
      {
        name: 'motion-prompts',
        phase: { number: 5, name: 'Writing motion prompts…' },

        promptName: 'phase/motion-prompt-scene-generation-chat',
        promptVariables,

        modelId: analysisModelId,
        responseSchema: motionPromptSchema,

        additionalMetadata,
      },
      {
        sequenceId,
        scopedDb,
      }
    );

    if (sequenceId && frameId) {
      if (!motionPrompt.fullPrompt) {
        throw new Error(
          `Motion prompt generation returned empty fullPrompt for scene ${scene.sceneId}`
        );
      }

      // Hash inputs are narrowed by the scene's continuity (populated upstream
      // by the visual-prompt workflow) so unreferenced entities don't poison
      // the stored hash.
      const narrowed = narrowFramePromptContext({
        scene,
        styleConfig,
        characterBible,
        locationBible,
        elementBible,
        aspectRatio,
        analysisModel: analysisModelId,
      });
      const inputHash = await computeMotionPromptInputHash(narrowed);

      const enrichedScene = {
        ...scene,
        prompts: {
          ...scene.prompts,
          motion: motionPrompt,
        },
      };

      await context.run('save-motion-prompt-to-db', async () => {
        const previous = await scopedDb.framePromptVariants.getLatest(
          frameId,
          'motion'
        );
        const source = previous ? 'regenerated' : 'ai-generated';

        await scopedDb.frames.update(frameId, { metadata: enrichedScene });

        await scopedDb.framePromptVariants.write({
          frameId,
          promptType: 'motion',
          text: motionPrompt.fullPrompt,
          components: motionPrompt.components,
          parameters: motionPrompt.parameters,
          source,
          inputHash,
          analysisModel: analysisModelId,
        });

        await getGenerationChannel(sequenceId).emit(
          'generation.frame:updated',
          {
            frameId,
            updateType: 'motion-prompt',
            metadata: enrichedScene,
          }
        );
      });
    }
    return { sceneId: scene.sceneId, motionPrompt };
  },
  {
    failureFunction: async ({ context, failStatus, failResponse }) => {
      const error = sanitizeFailResponse(failResponse);
      console.error('[MotionPromptSceneWorkflow] Failed', {
        workflowRunId: context.workflowRunId,
        failStatus,
        failResponse: error,
      });
      return `Motion prompt generation failed: ${error}`;
    },
  }
);
