/**
 * Motion & Music Prompts Workflow
 *
 * Orchestrates motion prompt generation + music design in parallel.
 * Runs as one strand in parallel with frame-images-workflow.
 */

import { DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { snapDuration } from '@/lib/motion/motion-generation';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  MotionMusicPromptsWorkflowInput,
  MotionMusicPromptsWorkflowResult,
  MusicSceneSummary,
} from '@/lib/workflow/types';
import { reinforceInstrumentalTags } from '../prompts/music-prompt';
import { motionPromptWorkflow } from './motion-prompt-workflow';
import { generateMusicPromptWorflow } from './music-prompt-workflow';

export const motionMusicPromptsWorkflow = createScopedWorkflow<
  MotionMusicPromptsWorkflowInput,
  MotionMusicPromptsWorkflowResult
>(
  async (context) => {
    const input = context.requestPayload;
    const {
      scenesWithVisualPrompts,
      aspectRatio,
      characterBible,
      locationBible,
      styleConfig,
      analysisModelId,
      videoModel,
      sequenceId,
      userId,
      teamId,
      frameMapping,
    } = input;

    const label = buildWorkflowLabel(sequenceId);

    const modelKey = videoModel || DEFAULT_VIDEO_MODEL;

    // Snap durations upfront so both motion prompts and music design
    // see identical, model-accurate duration values
    const scenesWithSnappedDurations: Scene[] = await context.run(
      'snap-durations',
      () =>
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
    );

    // Build scene summaries for music design (uses snapped durations)
    const sceneSummaries: MusicSceneSummary[] = scenesWithSnappedDurations.map(
      (scene) => ({
        sceneId: scene.sceneId,
        title: scene.metadata?.title || 'Untitled Scene',
        storyBeat: scene.metadata?.storyBeat || '',
        durationSeconds: scene.metadata?.durationSeconds || 5,
        location: scene.metadata?.location || '',
        timeOfDay: scene.metadata?.timeOfDay || '',
        visualSummary: scene.prompts?.visual?.components.atmosphere || '',
      })
    );

    // Run motion prompts and music design in parallel
    const [motionPromptsResults, musicDesignResult] = await Promise.all([
      context.invoke('motion-prompts', {
        workflow: motionPromptWorkflow,
        label,
        body: {
          userId,
          teamId,
          sequenceId,
          scenes: scenesWithSnappedDurations,
          aspectRatio,
          characterBible,
          locationBible,
          styleConfig,
          analysisModelId,
          frameMapping,
        },
      }),
      context.invoke('music-prompt', {
        workflow: generateMusicPromptWorflow,
        label,
        body: {
          userId,
          teamId,
          sequenceId,
          sceneSummaries,
          analysisModelId,
        },
      }),
    ]);

    if (motionPromptsResults.isFailed || motionPromptsResults.isCanceled)
      throw new Error('Motion prompt generation failed');
    if (musicDesignResult.isFailed || musicDesignResult.isCanceled)
      throw new Error('Music design generation failed');

    const motionPrompts = motionPromptsResults.body;
    const musicDesign = musicDesignResult.body;

    // Merge music design into scenes
    const completeScenes: Scene[] = await context.run(
      'merge-music-and-motion',
      () =>
        scenesWithSnappedDurations.map((scene) => {
          const motionPrompt = motionPrompts.find(
            (s) => s.sceneId === scene.sceneId
          );
          if (!motionPrompt) {
            throw new WorkflowValidationError(
              `Scene ID mismatch in motion prompts: expected "${scene.sceneId}"`
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
    );

    // Save motion prompts to frames

    return {
      completeScenes,
      musicPrompt: musicDesign.prompt,
      musicTags: reinforceInstrumentalTags(musicDesign.tags),
    };
  },
  {
    failureFunction: async () => {
      return 'Motion/music prompt generation failed';
    },
  }
);
