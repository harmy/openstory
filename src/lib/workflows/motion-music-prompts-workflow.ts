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
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`.
 *   - Replaces `Promise.all([context.invoke(...), context.invoke(...)])` with
 *     two parallel `spawnAndAwaitChild` calls (Pattern 3 from
 *     docs/investigations/cloudflare-workflows.md §4 Gap A).
 * */

import { DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import type { MotionPrompt, Scene } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { snapDuration } from '@/lib/motion/motion-generation';
import { reinforceInstrumentalTags } from '@/lib/prompts/music-prompt';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  MotionMusicPromptsWorkflowInput,
  MotionMusicPromptsWorkflowResult,
  MotionPromptWorkflowInput,
  MusicPromptWorkflowInput,
  MusicPromptWorkflowResult,
} from '@/lib/workflow/types';
import { buildMusicSceneSummaries } from '@/lib/workflows/music-scene-summaries';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'motion-music-prompts']);

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
      aspectRatio,
      characterBible,
      locationBible,
      elementBible,
      styleConfig,
      frameMapping,
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

    // Run motion prompts and music design in parallel via Pattern 3.
    const musicBinding = this.env.MUSIC_PROMPT_WORKFLOW;
    const motionBinding = this.env.MOTION_PROMPT_WORKFLOW;
    if (!musicBinding || !motionBinding) {
      throw new WorkflowValidationError(
        '[MotionMusicPromptsWorkflow:cf] MUSIC_PROMPT_WORKFLOW or MOTION_PROMPT_WORKFLOW binding missing on env; check wrangler.jsonc'
      );
    }

    const [motionPrompts, musicDesign] = await Promise.all([
      spawnAndAwaitChild<MotionPromptWorkflowInput, MotionPromptsResult>(step, {
        binding: motionBinding as Workflow<
          MotionPromptWorkflowInput & {
            _parent: import('@/lib/workflow/await-child').ParentNotifyHint;
          }
        >,
        parentBindingName: 'MOTION_MUSIC_PROMPTS_WORKFLOW',
        parentInstanceId: event.instanceId,
        childId: `motion-prompts:${sequenceId}`,
        childPayload: {
          userId,
          teamId,
          sequenceId,
          scenes: scenesWithSnappedDurations,
          aspectRatio,
          characterBible,
          locationBible,
          elementBible,
          styleConfig,
          analysisModelId,
          frameMapping,
        },
        spawnStepName: 'spawn-motion-prompts',
        awaitStepName: 'await-motion-prompts',
      }),
      spawnAndAwaitChild<MusicPromptWorkflowInput, MusicPromptWorkflowResult>(
        step,
        {
          binding: musicBinding as Workflow<
            MusicPromptWorkflowInput & {
              _parent: import('@/lib/workflow/await-child').ParentNotifyHint;
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
    logger.error(
      `[MotionMusicPromptsWorkflow:cf] Motion/music prompt generation failed: ${error}`
    );
  }
}
