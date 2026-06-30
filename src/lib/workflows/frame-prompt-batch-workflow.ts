/**
 * Cloudflare Workflows port of `visualPromptWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/frame-prompt-batch-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - The QStash original fanned out N scenes via `context.invoke`; this port
 *     fans out to the `FramePromptWorkflow` child via Pattern 3
 *     (`spawnAndAwaitChild`) so the parent stays thin and each scene's spawn /
 *     await pair gets its own retry budget. See await-child.ts.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`. */

import type { Scene, VisualPrompt } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type {
  FramePromptWorkflowInput,
  FramePromptBatchWorkflowInput,
  FramePromptBatchWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'frame-prompt-batch']);

// NOTE: `FRAME_PROMPT_BATCH_WORKFLOW` is not yet declared on `CloudflareEnv` —
// the parent binding gets wired into `src/lib/workflow/types.ts` and
// `wrangler.jsonc` as part of the follow-on infra PR. Until then, the
// `parentBindingName` below is a string cast; the runtime lookup in
// `notifyParent` / `notifyParentOfFailure` would only fire if this workflow
// itself were spawned as a child (it's a top-level orchestrator today, so
// `_parent` is always undefined and the cast is dormant).
// TODO(#728-wire-up): drop the cast once types.ts knows about
// FRAME_PROMPT_BATCH_WORKFLOW.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- binding name not yet declared on CloudflareEnv; see TODO above
const PARENT_BINDING_NAME =
  'FRAME_PROMPT_BATCH_WORKFLOW' as unknown as Parameters<
    typeof spawnAndAwaitChild
  >[1]['parentBindingName'];

type FramePromptResult = { sceneId: string; visual: VisualPrompt };

export class FramePromptBatchWorkflow extends OpenStoryWorkflowEntrypoint<FramePromptBatchWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<FramePromptBatchWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<FramePromptBatchWorkflowResult> {
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
      return { scenes: [], visualPromptsBySceneId: {} };
    }

    const visualPromptSceneBinding = this.env.FRAME_PROMPT_WORKFLOW;

    // Resolve each shot's anchor frame id ONCE, up front, and pass it to the
    // per-scene children so they never read the DB (#991). The anchor frame's
    // *identity* is immutable (only its selected image/version mutates), so
    // this single batched read is not the racy category the no-DB-reads rule
    // targets — it just spares each child a lookup. Keyed by shotId.
    const frameIdByShotId = await step.do('resolve-anchor-frames', async () => {
      const shotIds = (shotMapping ?? [])
        .map((m) => m.shotId)
        .filter((id): id is string => Boolean(id));
      const anchors = await scopedDb.frames.getAnchorsByShots(shotIds);
      const out: Record<string, string> = {};
      for (const [shotId, frame] of anchors) out[shotId] = frame.id;
      return out;
    });

    // ============================================================
    // PHASE 3: Visual Prompt Generation — fan out one
    // FramePromptWorkflow child per scene. Spawns happen in parallel
    // via Promise.all; the awaits are wrapped in Promise.allSettled so a
    // single timed-out child does not tank the entire parent run (matches
    // the per-scene retry semantics the QStash version got from
    // `context.invoke` + `retries: 3`).
    // ============================================================
    const spawnPromises = scenes.map(async (scene, sceneIndex) => {
      const sceneBefore = sceneIndex > 0 ? scenes[sceneIndex - 1] : undefined;
      const sceneAfter =
        sceneIndex < scenes.length - 1 ? scenes[sceneIndex + 1] : undefined;

      const shotId = shotMapping?.find(
        (f) => f.analysisSceneId === scene.sceneId
      )?.shotId;

      const childPayload: FramePromptWorkflowInput = {
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
        // Shot id of the scene to save the visual prompt to, plus its anchor
        // frame id resolved up front (#991: the child does not read the DB).
        shotId,
        frameId: shotId ? (frameIdByShotId[shotId] ?? null) : null,
      };

      const childResult = await spawnAndAwaitChild<
        FramePromptWorkflowInput,
        FramePromptResult
      >(step, {
        binding: visualPromptSceneBinding,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId: event.instanceId,
        childId: `frame-prompt:${sequenceId ?? 'no-seq'}:${scene.sceneId}`,
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
      async (): Promise<FramePromptBatchWorkflowResult> => {
        const successResults: Array<{
          scene: Scene;
          childResult: FramePromptResult;
        }> = [];
        const failedSceneIds: string[] = [];

        for (const [index, outcome] of settled.entries()) {
          const scene = scenes[index];
          if (outcome.status === 'rejected') {
            logger.error(
              `[FramePromptBatchWorkflow:cf] Child frame-prompt failed for scene ${scene?.sceneId ?? `index ${index}`}:`,
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
            `frame-prompt child(ren) returned no body for scene(s) [${failedSceneIds.join(', ')}]. ` +
              `Check sub-workflow logs for the upstream failure.`,
            'WorkflowValidationError'
          );
        }

        // The child persists each prompt to `frame_prompt_versions` (#713) — it
        // is NOT merged back into `scene.prompts` (that field is gone). But we
        // ALSO return the generated prompts in memory, keyed by sceneId, so the
        // parent pipeline threads them to the next phase rather than re-reading
        // the racy DB mirror.
        const visualPromptsBySceneId: Record<string, VisualPrompt> = {};
        for (const scene of scenes) {
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
          visualPromptsBySceneId[scene.sceneId] = enrichment.childResult.visual;
        }
        return { scenes, visualPromptsBySceneId };
      }
    );

    return scenesWithVisualPrompts;
  }

  protected override onFailure({
    error,
  }: {
    event: Readonly<WorkflowEvent<FramePromptBatchWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): void {
    logger.error(
      `[FramePromptBatchWorkflow:cf] Visual prompt generation failed: ${error}`
    );
  }
}
