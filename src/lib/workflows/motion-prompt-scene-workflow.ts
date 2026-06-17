/**
 * Cloudflare Workflows port of `motionPromptSceneWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/motion-prompt-scene-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`.
 *   - The streaming LLM call goes through `durableStreamingLLMCallCf`, driven
 *     by `step.do`. */

import { computeMotionPromptInputHash } from '@/lib/ai/input-hash';
import { analysisModelSupportsVision } from '@/lib/ai/models.config';
import { narrowFramePromptContext } from '@/lib/ai/prompt-context';
import {
  motionPromptSchema,
  type MotionPrompt,
} from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import { getFramePromptChannel, getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type { MotionPromptSceneWorkflowInput } from '@/lib/workflow/types';
import { durableStreamingLLMCallCf } from '@/lib/workflows/llm-call-helper';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'motion-prompt-scene']);

type MotionPromptSceneWorkflowResult = {
  sceneId: string;
  motionPrompt: MotionPrompt;
};

export class MotionPromptSceneWorkflow extends OpenStoryWorkflowEntrypoint<MotionPromptSceneWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MotionPromptSceneWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<MotionPromptSceneWorkflowResult> {
    const input = event.payload;
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
      startingFrameImageUrl,
    } = input;

    // ============================================================
    // PHASE 3: Motion Prompt Generation (using durableLLMCall helper)
    // ============================================================

    // The motion prompt is conditioned on the rendered starting frame (#929):
    // it's passed to the LLM as a vision input so motion continues the exact
    // pose/composition the image committed to, and the image URL is folded
    // into the staleness hash so a re-render re-stales the prompt.
    //
    // CRITICAL: the still arrives as an INPUT (`startingFrameImageUrl`),
    // snapshotted by the trigger when frame images finished — this workflow
    // must NOT look it up from the DB. A workflow can run/retry/replay at any
    // time, and a concurrent re-render could swap `frame.thumbnailUrl` mid-run;
    // reading it here would condition the prompt on an image the trigger never
    // saw. Null/absent → no still, text-only path.
    if (!startingFrameImageUrl) {
      logger.info(
        `[MotionPromptSceneWorkflow:cf] No starting frame provided for ${scene.sceneId}; generating motion prompt without vision input`
      );
    }

    // Narrow the bibles to this scene's entities (via `scene.continuity`, set
    // by scene-split) before the LLM call, so the model and the staleness hash
    // see the same minimal, scene-scoped input. See #867.
    const narrowed = narrowFramePromptContext({
      scene,
      styleConfig,
      characterBible,
      locationBible,
      elementBible,
      aspectRatio,
      analysisModel: analysisModelId,
      startingFrameImageUrl: startingFrameImageUrl ?? null,
    });

    const promptVariables = {
      sceneBefore: sceneBefore
        ? JSON.stringify(sceneBefore, null, 2)
        : '(none)',
      sceneAfter: sceneAfter ? JSON.stringify(sceneAfter, null, 2) : '(none)',
      scene: JSON.stringify(scene, null, 2),
      characterBible: JSON.stringify(narrowed.characterBible, null, 2),
      locationBible: JSON.stringify(narrowed.locationBible, null, 2),
      elementBible: JSON.stringify(narrowed.elementBible, null, 2),
      styleConfig: JSON.stringify(styleConfig, null, 2),
      aspectRatio,
    };

    logger.info(
      `[MotionPromptSceneWorkflow:cf] Generating motion prompt for scene ${scene.sceneId}`
    );

    const motionPrompt: MotionPrompt = await durableStreamingLLMCallCf(
      step,
      {
        name: 'motion-prompts',
        phase: { number: 5, name: 'Writing motion prompts…' },
        promptName: 'phase/motion-prompt-scene-generation-chat',
        promptVariables,
        modelId: analysisModelId,
        responseSchema: motionPromptSchema,
        additionalMetadata: { frameId },
        reasoning: true,
        // Only attach the still when the chosen analysis model accepts image
        // input; otherwise OpenRouter would reject the request. Non-vision
        // models still get the (now image-aware) text prompt. The staleness
        // hash always folds in the image regardless, so switching to a vision
        // model later re-generates with the still.
        visionImageUrls:
          startingFrameImageUrl && analysisModelSupportsVision(analysisModelId)
            ? [startingFrameImageUrl]
            : undefined,
      },
      {
        sequenceId,
        workflowRunId: event.instanceId,
        scopedDb,
        framePromptStream:
          input.emitStreaming && frameId
            ? { frameId, promptType: 'motion' }
            : undefined,
      }
    );

    if (sequenceId && frameId) {
      if (!motionPrompt.fullPrompt) {
        throw new Error(
          `Motion prompt generation returned empty fullPrompt for scene ${scene.sceneId}`
        );
      }

      // Hash the same scene-scoped `narrowed` context the LLM was given above,
      // so the stored hash equals the verify-time recompute by construction.
      const inputHash = await computeMotionPromptInputHash(narrowed);

      const enrichedScene = {
        ...scene,
        prompts: {
          ...scene.prompts,
          motion: motionPrompt,
        },
      };

      await step.do('save-motion-prompt-to-db', async () => {
        const previous = await scopedDb.framePromptVariants.getLatest(
          frameId,
          'motion'
        );
        const source = previous ? 'regenerated' : 'ai-generated';

        // Clear `frame.motionPrompt` user-override when regenerating; see
        // the matching note in visual-prompt-scene-workflow.ts. The variant
        // row below preserves the new prompt; the prior user override is
        // restorable from the prompt-history sheet.
        await scopedDb.frames.update(frameId, {
          metadata: enrichedScene,
          motionPrompt: null,
        });

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

        if (input.emitStreaming) {
          await getFramePromptChannel(frameId).emit('framePrompt.completed', {
            promptType: 'motion',
          });
        }
      });
    }
    return { sceneId: scene.sceneId, motionPrompt };
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<MotionPromptSceneWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    logger.error('[MotionPromptSceneWorkflow:cf] Failed', { error });
    try {
      const payload = event.payload;
      if (payload.emitStreaming && payload.frameId) {
        await getFramePromptChannel(payload.frameId).emit(
          'framePrompt.failed',
          { promptType: 'motion', error }
        );
      }
    } catch (emitErr) {
      logger.warn('[MotionPromptSceneWorkflow:cf] failed to emit failure', {
        err: emitErr,
      });
    }
  }
}
