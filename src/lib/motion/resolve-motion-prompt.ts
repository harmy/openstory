/**
 * Shared Motion Prompt Resolution
 *
 * Resolves the motion prompt string for a shot, applying model-specific
 * assembly when structured MotionPrompt data is available.
 *
 * Priority: user override → model-specific assembly → legacy fallback
 */

import type { MotionPrompt } from '@/lib/ai/scene-analysis.schema';
import {
  type ImageToVideoModel,
  videoModelSupportsAudio,
} from '@/lib/ai/models';
import { assembleMotionPrompt } from './assemble-motion-prompt';

type ShotPromptData = {
  motionPrompt: string | null;
  metadata: {
    prompts?: { motion?: MotionPrompt };
    continuity?: { characterTags?: readonly string[] };
  } | null;
  description: string | null;
};

/**
 * Resolve the motion prompt for a shot, formatted for the target video model.
 *
 * - If the user has manually edited the prompt (shot.motionPrompt), it wins
 *   but dialogue/audio are appended for audio-capable models.
 * - If structured MotionPrompt data exists, assemble a model-specific prompt.
 * - Otherwise fall back to shot.description.
 */
export function resolveMotionPrompt(
  shot: ShotPromptData,
  model: ImageToVideoModel
): string {
  const motionPromptData = shot.metadata?.prompts?.motion;
  const characterTags = shot.metadata?.continuity?.characterTags;

  // User override: manually edited prompt string
  if (shot.motionPrompt) {
    // For audio models, enrich the user's prompt with dialogue/audio if available
    if (videoModelSupportsAudio(model) && motionPromptData) {
      return assembleMotionPrompt({
        motionPrompt: { ...motionPromptData, fullPrompt: shot.motionPrompt },
        model,
        characterTags,
      });
    }
    return shot.motionPrompt;
  }

  // Structured data available — assemble for target model
  if (motionPromptData) {
    return assembleMotionPrompt({
      motionPrompt: motionPromptData,
      model,
      characterTags,
    });
  }

  // Legacy fallback
  return shot.description || '';
}
