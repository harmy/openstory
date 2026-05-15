/**
 * Visual Prompt Generation Workflow
 *
 * Generates visual prompts for scenes based on character bible and style config.
 * Uses three-step durable pattern: prepare → context.call → log
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { VisualPromptWorkflowInput } from '@/lib/workflow/types';
import { getLLMFlowControl } from './constants';
import { visualPromptSceneWorkflow } from './visual-prompt-scene-workflow';

export const visualPromptWorkflow = createScopedWorkflow<
  VisualPromptWorkflowInput,
  Scene[]
>(
  async (context) => {
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
    // PHASE 3: Visual Prompt Generation (using durableLLMCall helper)
    // ============================================================
    const visualPromptResults = await Promise.all(
      scenes.map(async (scene, sceneIndex) => {
        const sceneBefore = sceneIndex > 0 ? scenes[sceneIndex - 1] : undefined;
        const sceneAfter =
          sceneIndex < scenes.length - 1 ? scenes[sceneIndex + 1] : undefined;

        return await context.invoke('visual-prompt-scene', {
          workflow: visualPromptSceneWorkflow,
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
            // Frame id of the scene to save the visual prompt to
            frameId: frameMapping?.find((f) => f.sceneId === scene.sceneId)
              ?.frameId,
          },
          flowControl: getLLMFlowControl(),
          retries: 3,
          retryDelay: '10000 * pow(2, retried)',
        });
      })
    );

    // Not sure this actually needs to be a workflow step, but it's here for now
    // Merge in the response (visual prompts AND continuity)
    const { scenes: scenesWithVisualPrompts } = await context.run(
      'merge-visual-prompts',
      async () => {
        const failedInvokes = visualPromptResults
          .map((result, index) => ({ result, sceneId: scenes[index]?.sceneId }))
          .filter(
            ({ result }) => result.isFailed || result.isCanceled || !result.body
          );
        if (failedInvokes.length > 0) {
          throw new WorkflowValidationError(
            `visual-prompt-scene invoke(s) returned no body for scene(s) [${failedInvokes
              .map(
                ({ result, sceneId }) =>
                  `${sceneId}${result.isFailed ? ' (failed)' : ''}${result.isCanceled ? ' (canceled)' : ''}`
              )
              .join(', ')}]. Check sub-workflow logs for the upstream failure.`
          );
        }

        return {
          scenes: scenes.map((scene) => {
            const enrichment = visualPromptResults.find(
              (s) => s.body.sceneId === scene.sceneId
            );
            if (!enrichment) {
              throw new WorkflowValidationError(
                `Scene ID mismatch in visual prompts: expected "${scene.sceneId}" but AI returned [${visualPromptResults.map((s) => s.body.sceneId).join(', ')}]. ` +
                  `Input had [${scenes.map((s) => s.sceneId).join(', ')}].`
              );
            }
            return {
              ...scene,
              prompts: {
                ...scene.prompts,
                visual: enrichment.body.visual,
              },
              continuity: enrichment.body.continuity,
            };
          }),
        };
      }
    );

    return scenesWithVisualPrompts;
  },
  {
    failureFunction: async () => {
      return `Visual prompt generation failed`;
    },
  }
);
