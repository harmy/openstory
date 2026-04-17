/**
 * Model-Aware Motion Prompt Assembly
 *
 * The LLM generates a rich `fullPrompt` with camera direction, performance,
 * and atmosphere. This module enriches that prompt with model-specific
 * dialogue formatting and audio sections at generation time.
 *
 * Strategy: fullPrompt is always the base. Provider builders ADD to it
 * (dialogue lines, audio sections) rather than rebuilding from components.
 */

import type {
  DialogueLine,
  MotionPrompt,
} from '@/lib/ai/scene-analysis.schema';
import {
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
  videoModelSupportsAudio,
} from '@/lib/ai/models';
type MotionDialogue = NonNullable<MotionPrompt['dialogue']>;
type MotionAudio = NonNullable<MotionPrompt['audio']>;

type AssembleOptions = {
  motionPrompt: MotionPrompt;
  model: ImageToVideoModel;
};

/**
 * Assemble a model-specific motion prompt from structured data.
 *
 * The LLM's `fullPrompt` provides the rich narrative base. For audio-capable
 * models, we append dialogue lines and audio direction in the format each
 * model handles best. Non-audio models get `fullPrompt` as-is.
 */
export function assembleMotionPrompt({
  motionPrompt,
  model,
}: AssembleOptions): string {
  const { dialogue, audio, fullPrompt } = motionPrompt;
  const supportsAudio = videoModelSupportsAudio(model);
  const provider = IMAGE_TO_VIDEO_MODELS[model].provider;

  let assembled: string;

  // Non-audio models: fullPrompt is already great, no enrichment needed
  if (!supportsAudio) {
    assembled = fullPrompt;
  } else {
    // Audio-capable models: enrich fullPrompt with dialogue + audio sections
    const hasDialogue = dialogue?.presence && dialogue.lines.length > 0;
    const dialogueData = hasDialogue ? dialogue : undefined;

    switch (provider) {
      case 'Kling':
        assembled = buildKlingPrompt(fullPrompt, dialogueData, audio);
        break;
      case 'Google':
      default:
        assembled = buildVeoPrompt(fullPrompt, dialogueData, audio);
        break;
    }
  }

  return assembled;
}

// ---------------------------------------------------------------------------
// Kling 3.0: Character labels with tone + temporal markers + ambient sounds
// Guide: https://blog.fal.ai/kling-3-0-prompting-guide/
// ---------------------------------------------------------------------------

function buildKlingPrompt(
  fullPrompt: string,
  dialogue: MotionDialogue | undefined,
  audio: MotionAudio | undefined
): string {
  const parts = [fullPrompt];

  // Append dialogue with Kling-specific character labels and temporal markers
  if (dialogue) {
    parts.push(formatKlingDialogue(dialogue.lines));
  }

  // Ambient sound woven into the prompt (Kling generates audio natively)
  if (audio) {
    const ambientParts: string[] = [];
    if (audio.ambientSound) ambientParts.push(audio.ambientSound);
    if (audio.soundEffects.length > 0)
      ambientParts.push(audio.soundEffects.join(', '));
    if (ambientParts.length > 0) {
      parts.push(`Ambient sounds: ${ambientParts.join('. ')}.`);
    }
  }

  return parts.join('\n\n');
}

function formatKlingDialogue(lines: DialogueLine[]): string {
  return lines
    .map((line) => {
      const label = line.character || 'Narrator';
      const tone = line.tone ? `, ${line.tone}` : '';
      return `[${label}${tone}]: "${line.line}"`;
    })
    .join('\nImmediately, ');
}

// ---------------------------------------------------------------------------
// Google Veo 3/3.1 + OpenAI Sora: Natural narrative quotes + Audio: section
// Guide: https://fal.ai/learn/devs/veo3-prompt-guide
// ---------------------------------------------------------------------------

function buildVeoPrompt(
  fullPrompt: string,
  dialogue: MotionDialogue | undefined,
  audio: MotionAudio | undefined
): string {
  const parts = [fullPrompt];

  // Append dialogue as natural narrative with inline quotes
  if (dialogue) {
    const dialogueNarrative = dialogue.lines
      .map((line) => {
        const subject = line.character || 'A voice';
        const tone = line.tone ? ` in a ${line.tone} voice` : '';
        return `${subject} says${tone}, "${line.line}"`;
      })
      .join('. ');
    parts.push(dialogueNarrative + '.');
  }

  // Separate Audio: section (Veo guide recommendation)
  if (audio) {
    const audioParts: string[] = [];
    if (audio.ambientSound) audioParts.push(audio.ambientSound);
    if (audio.soundEffects.length > 0)
      audioParts.push(audio.soundEffects.join(', '));
    if (audioParts.length > 0) {
      parts.push(`Audio: ${audioParts.join('. ')}`);
    }
  }

  return parts.join('\n\n');
}
