/**
 * Cloudflare Workflows port of `motionPromptWorkflow`.
 *
 * Wave 3 mid-tier orchestrator: fans out one `motion-prompt-scene` child per
 * scene and awaits all results. Mirrors the QStash version
 * (`src/lib/workflows/motion-prompt-workflow.ts`) step for step — same control
 * flow, same side effects. The only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Reads payload from `event.payload` instead of `context.requestPayload`
 *     and the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`.
 *   - The Promise.all over `context.invoke('motion-prompt-scene', ...)`
 *     becomes Promise.allSettled over `spawnAndAwaitChild` (Pattern 3 fan-out
 *     helpers in `await-child.ts`). Each child gets a deterministic
 *     instance ID and a unique event-type qualifier so siblings cannot match
 *     each other's completion events.
 *   - `failureFunction` → `onFailure`.
 *
 * Uses `Promise.allSettled` rather than `Promise.all` so that a single
 * child timeout (waitForEvent default: 30 minutes) does not kill the parent
 * — the parent still surfaces a terminal error, but only after every other
 * sibling has resolved one way or the other. */

import type { MotionPrompt } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  MotionPromptSceneWorkflowInput,
  MotionPromptWorkflowInput,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'motion-prompt']);

type MotionPromptSceneWorkflowResult = {
  sceneId: string;
  motionPrompt: MotionPrompt;
};

type MotionPromptWorkflowResult = MotionPromptSceneWorkflowResult[];

export class MotionPromptWorkflow extends OpenStoryWorkflowEntrypoint<MotionPromptWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MotionPromptWorkflowInput>>,
    step: WorkflowStep,
    _scopedDb: ScopedDb
  ): Promise<MotionPromptWorkflowResult> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
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
      startingFrameImageUrls,
    } = input;

    // ============================================================
    // Top-level validation (re-throws as NonRetryableError via the base
    // class's WorkflowValidationError re-wrap). Inside step.do we use
    // CF's NonRetryableError directly so the step machinery doesn't burn
    // its retry budget on programmer errors.
    // ============================================================
    if (!sequenceId) {
      throw new WorkflowValidationError(
        '[MotionPromptWorkflow:cf] sequenceId is required for fan-out'
      );
    }

    const childBinding = this.env.MOTION_PROMPT_SCENE_WORKFLOW;

    // ============================================================
    // PHASE 3: Motion Prompt Generation — fan out per scene
    // ============================================================
    const settled = await Promise.allSettled(
      scenes.map((scene, sceneIndex) => {
        const sceneBefore = sceneIndex > 0 ? scenes[sceneIndex - 1] : undefined;
        const sceneAfter =
          sceneIndex < scenes.length - 1 ? scenes[sceneIndex + 1] : undefined;
        const childPayload: MotionPromptSceneWorkflowInput = {
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
          sequenceId,
          shotId: shotMapping?.find((f) => f.analysisSceneId === scene.sceneId)
            ?.shotId,
          // Pass the rendered still per scene, snapshotted upstream (#929) —
          // never looked up inside the child workflow.
          startingFrameImageUrl:
            startingFrameImageUrls?.[scene.sceneId] ?? null,
        };

        return spawnAndAwaitChild<
          MotionPromptSceneWorkflowInput,
          MotionPromptSceneWorkflowResult
        >(step, {
          binding: childBinding,
          parentBindingName: 'MOTION_PROMPT_WORKFLOW',
          parentInstanceId,
          childId: `motion-prompt-scene:${sequenceId}:${scene.sceneId}`,
          childPayload,
          spawnStepName: `spawn-mp-scene-${sceneIndex}`,
          awaitStepName: `await-mp-scene-${sceneIndex}`,
        });
      })
    );

    // Collect failures so we can surface a single descriptive error rather
    // than whatever happened to land in the first rejected slot.
    const failures: string[] = [];
    const results: MotionPromptSceneWorkflowResult[] = [];
    for (const [i, outcome] of settled.entries()) {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        const scene = scenes[i];
        const reason =
          outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason);
        failures.push(`scene ${scene?.sceneId ?? `#${i}`}: ${reason}`);
      }
    }

    if (failures.length > 0) {
      // Use a NonRetryableError here so CF doesn't retry the entire fan-out
      // when a child has already exhausted its own retries. The base class
      // will route this through onFailure + notifyParentOfFailure.
      throw new NonRetryableError(
        `[MotionPromptWorkflow:cf] Motion prompt generation failed for ${failures.length}/${scenes.length} scenes: ${failures.join('; ')}`,
        'MotionPromptFanOutError'
      );
    }

    return results.map((result) => ({
      sceneId: result.sceneId,
      motionPrompt: result.motionPrompt,
    }));
  }

  protected override onFailure({
    error,
  }: {
    event: Readonly<WorkflowEvent<MotionPromptWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): void {
    // Mirror QStash's `failureFunction`, which returned a static string and
    // performed no DB writes — per-scene failures already surface via the
    // child workflow's own onFailure (e.g. shotPrompt.failed emits).
    logger.error('[MotionPromptWorkflow:cf] Motion prompt generation failed', {
      error,
    });
  }
}
