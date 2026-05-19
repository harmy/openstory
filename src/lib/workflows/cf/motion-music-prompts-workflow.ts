/**
 * Cloudflare Workflows port of `motionMusicPromptsWorkflow`.
 *
 * Wave 3 mid-tier orchestrator: fans out to motion-prompts (per-scene tree)
 * and music-prompt (single scene-summaries → music design call) in parallel.
 *
 * Mirrors the QStash version (`src/lib/workflows/motion-music-prompts-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * The only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `cf/base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`.
 *   - Replaces `Promise.all([context.invoke(...), context.invoke(...)])` with
 *     two parallel `spawnAndAwaitChild` calls (Pattern 3 from
 *     docs/investigations/cloudflare-workflows.md §4 Gap A).
 *
 * NOTE: the `motion-prompts` workflow IS NOT yet ported as a CF workflow —
 * only the per-scene leaf (`motion-prompt-scene`) exists. Until the
 * Pattern 3 batch lands a CF-native parent for it, the motion-prompts arm
 * of the fan-out throws `NonRetryableError` from inside a `step.do` so the
 * engine registry keeps this workflow routed via QStash.
 *
 * The QStash version stays as-is — both run side by side until
 * `engine-registry.ts` flips `motion-music-prompts` to `'cloudflare'`. See
 * docs/investigations/cloudflare-workflows-poc.md.
 */

import { DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import type { MotionPrompt, Scene } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { snapDuration } from '@/lib/motion/motion-generation';
import { reinforceInstrumentalTags } from '@/lib/prompts/music-prompt';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/cf/base-workflow';
import { spawnAndAwaitChild } from '@/lib/workflow/cf/await-child';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  MotionMusicPromptsWorkflowInput,
  MotionMusicPromptsWorkflowResult,
  MusicPromptWorkflowInput,
  MusicPromptWorkflowResult,
} from '@/lib/workflow/types';
import { buildMusicSceneSummaries } from '@/lib/workflows/music-scene-summaries';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

type MotionPromptsResult = { sceneId: string; motionPrompt: MotionPrompt }[];

export class MotionMusicPromptsWorkflow extends OpenStoryWorkflowEntrypoint<MotionMusicPromptsWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MotionMusicPromptsWorkflowInput>>,
    step: WorkflowStep,
    _scopedDb: ScopedDb
  ): Promise<MotionMusicPromptsWorkflowResult> {
    const input = event.payload;
    const {
      scenesWithVisualPrompts,
      analysisModelId,
      videoModel,
      sequenceId,
      userId,
      teamId,
    } = input;

    const modelKey = videoModel || DEFAULT_VIDEO_MODEL;

    // Snap durations upfront so both motion prompts and music design see
    // identical, model-accurate duration values.
    const scenesWithSnappedDurations: Scene[] = await step.do(
      'snap-durations',
      () =>
        Promise.resolve(
          scenesWithVisualPrompts.map((scene) => ({
            ...scene,
            metadata: scene.metadata
              ? {
                  ...scene.metadata,
                  durationSeconds: snapDuration(
                    scene.metadata.durationSeconds,
                    modelKey
                  ),
                }
              : scene.metadata,
          }))
        )
    );

    // Build scene summaries for music design (uses snapped durations).
    const sceneSummaries = buildMusicSceneSummaries(scenesWithSnappedDurations);

    // Run motion prompts and music design in parallel.
    //
    // `motion-prompts` is not yet ported as a CF parent workflow — only the
    // per-scene leaf is — so we stub it inside a `step.do` with a
    // `NonRetryableError`. The dispatcher keeps this workflow on QStash via
    // engine-registry until the Pattern 3 batch lands a CF-native parent.
    //
    // `music-prompt` IS ported (see `cf/music-prompt-workflow.ts`); we spawn
    // it via `spawnAndAwaitChild` so the two arms run concurrently.
    const musicBinding = this.env.MUSIC_PROMPT_WORKFLOW;
    if (!musicBinding) {
      throw new WorkflowValidationError(
        '[MotionMusicPromptsWorkflow:cf] MUSIC_PROMPT_WORKFLOW binding missing on env; check wrangler.jsonc'
      );
    }

    const [motionPrompts, musicDesign] = await Promise.all([
      step.do('motion-prompts', async (): Promise<MotionPromptsResult> => {
        throw new NonRetryableError(
          'Child invocation pending Pattern 3 batch; route this workflow via QStash',
          'WorkflowValidationError'
        );
      }),
      spawnAndAwaitChild<MusicPromptWorkflowInput, MusicPromptWorkflowResult>(
        step,
        {
          binding: musicBinding as Workflow<
            MusicPromptWorkflowInput & {
              _parent: import('@/lib/workflow/cf/await-child').ParentNotifyHint;
            }
          >,
          parentBindingName: 'MOTION_MUSIC_PROMPTS_WORKFLOW',
          parentInstanceId: event.instanceId,
          childId: `music-prompt:${sequenceId}`,
          childPayload: {
            userId,
            teamId,
            sequenceId,
            sceneSummaries,
            analysisModelId,
          },
          spawnStepName: 'spawn-music-prompt',
          awaitStepName: 'await-music-prompt',
        }
      ),
    ]);

    // Merge music design into scenes.
    const completeScenes: Scene[] = await step.do(
      'merge-music-and-motion',
      () =>
        Promise.resolve(
          scenesWithSnappedDurations.map((scene) => {
            const motionPrompt = motionPrompts.find(
              (s) => s.sceneId === scene.sceneId
            );
            if (!motionPrompt) {
              throw new NonRetryableError(
                `Scene ID mismatch in motion prompts: expected "${scene.sceneId}"`,
                'WorkflowValidationError'
              );
            }
            const musicSceneDesign = musicDesign.scenes.find(
              (s) => s.sceneId === scene.sceneId
            );

            return {
              ...scene,
              prompts: {
                ...scene.prompts,
                motion: motionPrompt.motionPrompt,
              },
              musicDesign: musicSceneDesign?.musicDesign,
            };
          })
        )
    );

    // `aspectRatio`, `characterBible`, `locationBible`, `elementBible`,
    // `styleConfig`, and `frameMapping` are passed through to the stubbed
    // motion-prompts child once the Pattern 3 batch ports it. They're left
    // off this orchestrator's destructure for now to keep tsgo happy.
    return {
      completeScenes,
      musicPrompt: musicDesign.prompt,
      musicTags: reinforceInstrumentalTags(musicDesign.tags),
    };
  }

  protected override onFailure({
    error,
  }: {
    event: Readonly<WorkflowEvent<MotionMusicPromptsWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): void {
    console.error(
      '[MotionMusicPromptsWorkflow:cf]',
      `Motion/music prompt generation failed: ${error}`
    );
  }
}
