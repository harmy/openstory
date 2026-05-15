/**
 * Motion Prompt Workflow
 *
 * Generates motion prompts for all scenes, delegating to per-scene sub-workflows.
 * Uses three-step durable pattern: prepare → context.call → log
 */

import type { MotionPrompt } from '@/lib/ai/scene-analysis.schema';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { MotionPromptWorkflowInput } from '@/lib/workflow/types';
import { motionPromptSceneWorkflow } from './motion-prompt-scene-workflow';

export const motionPromptWorkflow = createScopedWorkflow<
  MotionPromptWorkflowInput,
  { sceneId: string; motionPrompt: MotionPrompt }[]
>(
  async (context, _scopedDb) => {
    const input = context.requestPayload;
    const {
      scenes,
      aspectRatio,
      characterBible,
      locationBible,
      elementBible,
      styleConfig,
      analysisModelId,
      frameMapping,
    } = input;

    const label = buildWorkflowLabel(input.sequenceId);

    // ============================================================
    // PHASE 3: Motion Prompt Generation (using durableLLMCall helper)
    // ============================================================
    const motionPromptResults = await Promise.all(
      scenes.map(async (scene, sceneIndex) => {
        const sceneBefore = sceneIndex > 0 ? scenes[sceneIndex - 1] : undefined;
        const sceneAfter =
          sceneIndex < scenes.length - 1 ? scenes[sceneIndex + 1] : undefined;

        return await context.invoke('motion-prompt-scene', {
          workflow: motionPromptSceneWorkflow,
          label,
          body: {
            scene,
            sceneBefore,
            sceneAfter,
            aspectRatio,
            characterBible,
            locationBible,
            elementBible,
            styleConfig,
            analysisModelId,
            teamId: input.teamId,
            userId: input.userId,
            sequenceId: input.sequenceId,
            frameId: frameMapping?.find((f) => f.sceneId === scene.sceneId)
              ?.frameId,
          },
        });
      })
    );

    return motionPromptResults.map((result) => {
      if (result.isFailed || result.isCanceled)
        throw new Error('Motion prompt generation failed');

      return {
        sceneId: result.body.sceneId,
        motionPrompt: result.body.motionPrompt,
      };
    });
  },
  {
    failureFunction: async () => {
      return `Motion prompt generation failed`;
    },
  }
);
