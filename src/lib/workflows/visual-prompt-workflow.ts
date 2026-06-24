/**
 * Cloudflare Workflows port of `visualPromptWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/visual-prompt-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - The QStash original fanned out N scenes via `context.invoke`; this port
 *     fans out to the `VisualPromptSceneWorkflow` child via Pattern 3
 *     (`spawnAndAwaitChild`) so the parent stays thin and each scene's spawn /
 *     await pair gets its own retry budget. See await-child.ts.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`. */

import type { Scene, VisualPrompt } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type {
  VisualPromptSceneWorkflowInput,
  VisualPromptWorkflowInput,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'visual-prompt']);

// NOTE: `VISUAL_PROMPT_WORKFLOW` is not yet declared on `CloudflareEnv` —
// the parent binding gets wired into `src/lib/workflow/types.ts` and
// `wrangler.jsonc` as part of the follow-on infra PR. Until then, the
// `parentBindingName` below is a string cast; the runtime lookup in
// `notifyParent` / `notifyParentOfFailure` would only fire if this workflow
// itself were spawned as a child (it's a top-level orchestrator today, so
// `_parent` is always undefined and the cast is dormant).
// TODO(#728-wire-up): drop the cast once types.ts knows about
// VISUAL_PROMPT_WORKFLOW.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- binding name not yet declared on CloudflareEnv; see TODO above
const PARENT_BINDING_NAME = 'VISUAL_PROMPT_WORKFLOW' as unknown as Parameters<
  typeof spawnAndAwaitChild
>[1]['parentBindingName'];

type VisualPromptSceneResult = { sceneId: string; visual: VisualPrompt };

export class VisualPromptWorkflow extends OpenStoryWorkflowEntrypoint<VisualPromptWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<VisualPromptWorkflowInput>>,
    step: WorkflowStep,
    _scopedDb: ScopedDb
  ): Promise<Scene[]> {
    const input = event.payload;
    const {
      scenes,
      aspectRatio,
      characterBible,
      locationBible,
      elementBible,
      styleConfig,
      analysisModelId,
      shotMapping,
      sequenceId,
    } = input;

    if (scenes.length === 0) {
      return [];
    }

    const visualPromptSceneBinding = this.env.VISUAL_PROMPT_SCENE_WORKFLOW;

    // ============================================================
    // PHASE 3: Visual Prompt Generation — fan out one
    // VisualPromptSceneWorkflow child per scene. Spawns happen in parallel
    // via Promise.all; the awaits are wrapped in Promise.allSettled so a
    // single timed-out child does not tank the entire parent run (matches
    // the per-scene retry semantics the QStash version got from
    // `context.invoke` + `retries: 3`).
    // ============================================================
    const spawnPromises = scenes.map(async (scene, sceneIndex) => {
      const sceneBefore = sceneIndex > 0 ? scenes[sceneIndex - 1] : undefined;
      const sceneAfter =
        sceneIndex < scenes.length - 1 ? scenes[sceneIndex + 1] : undefined;

      const childPayload: VisualPromptSceneWorkflowInput = {
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
        // Shot id of the scene to save the visual prompt to
        shotId: shotMapping?.find((f) => f.analysisSceneId === scene.sceneId)
          ?.shotId,
      };

      const childResult = await spawnAndAwaitChild<
        VisualPromptSceneWorkflowInput,
        VisualPromptSceneResult
      >(step, {
        binding: visualPromptSceneBinding,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId: event.instanceId,
        childId: `visual-prompt-scene:${sequenceId ?? 'no-seq'}:${scene.sceneId}`,
        childPayload,
        spawnStepName: `spawn-vp-scene-${sceneIndex}`,
        awaitStepName: `await-vp-scene-${sceneIndex}`,
        timeout: '30 minutes',
      });

      return { scene, childResult };
    });

    const settled = await Promise.allSettled(spawnPromises);

    // Not sure this actually needs to be a workflow step, but mirroring the
    // QStash original's `merge-visual-prompts` step name keeps trace parity.
    const scenesWithVisualPrompts = await step.do(
      'merge-visual-prompts',
      async (): Promise<Scene[]> => {
        const successResults: Array<{
          scene: Scene;
          childResult: VisualPromptSceneResult;
        }> = [];
        const failedSceneIds: string[] = [];

        for (const [index, outcome] of settled.entries()) {
          const scene = scenes[index];
          if (outcome.status === 'rejected') {
            logger.error(
              `[VisualPromptWorkflow:cf] Child visual-prompt-scene failed for scene ${scene?.sceneId ?? `index ${index}`}:`,
              {
                err: outcome.reason,
              }
            );
            if (scene) failedSceneIds.push(scene.sceneId);
            continue;
          }
          successResults.push(outcome.value);
        }

        if (failedSceneIds.length > 0) {
          // NonRetryableError (not WorkflowValidationError) because the base
          // class's re-wrap only runs at the runImpl catch boundary; a throw
          // inside step.do gets retried by CF's step machinery first.
          throw new NonRetryableError(
            `visual-prompt-scene child(ren) returned no body for scene(s) [${failedSceneIds.join(', ')}]. ` +
              `Check sub-workflow logs for the upstream failure.`,
            'WorkflowValidationError'
          );
        }

        return scenes.map((scene) => {
          const enrichment = successResults.find(
            (s) => s.childResult.sceneId === scene.sceneId
          );
          if (!enrichment) {
            throw new NonRetryableError(
              `Scene ID mismatch in visual prompts: expected "${scene.sceneId}" but AI returned [${successResults
                .map((s) => s.childResult.sceneId)
                .join(', ')}]. ` +
                `Input had [${scenes.map((s) => s.sceneId).join(', ')}].`,
              'WorkflowValidationError'
            );
          }
          // `scene.continuity` already came from scene-split; the child only
          // adds the visual prompt now.
          return {
            ...scene,
            prompts: {
              ...scene.prompts,
              visual: enrichment.childResult.visual,
            },
          };
        });
      }
    );

    return scenesWithVisualPrompts;
  }

  protected override onFailure({
    error,
  }: {
    event: Readonly<WorkflowEvent<VisualPromptWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): void {
    logger.error(
      `[VisualPromptWorkflow:cf] Visual prompt generation failed: ${error}`
    );
  }
}
