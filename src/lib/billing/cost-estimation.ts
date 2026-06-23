/**
 * Cost Estimation Utilities
 * Estimate generation costs before triggering workflows.
 * All functions return Microdollars for exact arithmetic.
 */

import { estimateFalCost } from '@/lib/ai/fal-cost';
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { aspectRatioToDimensions } from '@/lib/constants/aspect-ratios';
import { type Microdollars, addMicros, micros, multiplyMicros } from './money';

/**
 * Estimate the raw cost (before markup) of generating images. Rough pre-flight
 * gate only — the exact charge comes from fal's reported units post-generation.
 */
export function estimateImageCost(
  model: TextToImageModel,
  aspectRatio: AspectRatio,
  numImages: number,
  opts?: { resolution?: string }
): Microdollars {
  const { width, height } = aspectRatioToDimensions(aspectRatio);

  return estimateFalCost(IMAGE_MODELS[model].id, {
    numImages,
    widthPx: width,
    heightPx: height,
    resolution: opts?.resolution,
  });
}

/**
 * Estimate the raw cost (before markup) of generating video.
 */
export function estimateVideoCost(
  model: ImageToVideoModel,
  durationSeconds: number,
  opts?: { resolution?: string }
): Microdollars {
  return estimateFalCost(IMAGE_TO_VIDEO_MODELS[model].id, {
    durationSeconds,
    resolution: opts?.resolution,
  });
}

/**
 * Estimate the raw cost (before markup) of generating one music track.
 */
export function estimateAudioCost(
  model: AudioModel,
  durationSeconds: number
): Microdollars {
  return estimateFalCost(AUDIO_MODELS[model].id, { durationSeconds });
}

/**
 * Rough estimate of LLM cost per call for pre-flight credit checks.
 * Based on average token usage for script analysis calls.
 * Only used for client-side gate affordability checks, not actual deduction.
 */
const AVERAGE_LLM_COST_PER_CALL_MICROS = micros(20_000); // $0.02

export function estimateLLMCost(numCalls: number = 1): Microdollars {
  return multiplyMicros(AVERAGE_LLM_COST_PER_CALL_MICROS, numCalls);
}

/** Average scene count for a typical script (used when we can't know in advance) */
const DEFAULT_ESTIMATED_SCENE_COUNT = 8;

/**
 * Estimate the total cost of a storyboard workflow.
 * Includes: LLM analysis, character/location sheet images, per-shot images,
 * and optionally per-shot motion generation.
 */
export function estimateStoryboardCost(opts: {
  imageModel: TextToImageModel;
  /** Number of image models selected (multiplies per-shot image cost) */
  imageModelCount?: number;
  aspectRatio: AspectRatio;
  estimatedSceneCount?: number;
  autoGenerateMotion?: boolean;
  /**
   * Video models selected for per-shot motion (#545). Each model is priced
   * individually from its own parameters — fal returns no cost, so a uniform
   * per-model multiplier would mis-estimate a mixed (e.g. cheap + audio-capable)
   * selection. First is primary; all are billed once per shot.
   */
  videoModels?: ImageToVideoModel[];
  videoDurationSeconds?: number;
  autoGenerateMusic?: boolean;
  /**
   * Audio models selected for the per-sequence music track (#546). Each model
   * is priced individually from its own parameters — audio models have
   * genuinely different rates (e.g. ElevenLabs per-minute vs ACE-Step
   * per-second), so a uniform multiplier would mis-estimate a mixed selection.
   * First is primary; one track per model spans the sequence.
   */
  audioModels?: AudioModel[];
  /** Total sequence duration in seconds (one music track spans the sequence) */
  audioDurationSeconds?: number;
}): Microdollars {
  const sceneCount = opts.estimatedSceneCount ?? DEFAULT_ESTIMATED_SCENE_COUNT;
  const imageModelCount = opts.imageModelCount ?? 1;

  // LLM calls: script analysis + character bible + location bible (~3 calls)
  const llmCost = estimateLLMCost(3);

  // Character sheets (~3 characters on average, landscape_16_9)
  const characterSheetCost = estimateImageCost(opts.imageModel, '16:9', 3);

  // Location sheets (~3 locations on average, landscape_16_9)
  const locationSheetCost = estimateImageCost(opts.imageModel, '16:9', 3);

  // Per-shot images (multiplied by number of selected image models)
  const shotCost = multiplyMicros(
    estimateImageCost(opts.imageModel, opts.aspectRatio, sceneCount),
    imageModelCount
  );

  let totalCost = addMicros(
    addMicros(addMicros(llmCost, characterSheetCost), locationSheetCost),
    shotCost
  );

  // Optional motion generation for all shots. Each selected video model
  // produces its own video per shot, so sum each model's own per-shot cost
  // (priced from its parameters) rather than scaling one model's rate by a
  // count — a mixed selection has genuinely different per-model costs.
  if (opts.autoGenerateMotion && opts.videoModels?.length) {
    const duration = opts.videoDurationSeconds ?? 5;
    for (const model of opts.videoModels) {
      const perShotMotion = estimateVideoCost(model, duration);
      totalCost = addMicros(
        totalCost,
        multiplyMicros(perShotMotion, sceneCount)
      );
    }
  }

  // Optional music generation — one track per sequence per audio model. Sum
  // each selected model's own cost (priced from its parameters) rather than
  // scaling the primary's rate by a count — a mixed selection has genuinely
  // different per-model costs (mirrors the per-model video costing above).
  if (opts.autoGenerateMusic && opts.audioModels?.length) {
    const audioDuration = opts.audioDurationSeconds ?? sceneCount * 5;
    for (const model of opts.audioModels) {
      totalCost = addMicros(totalCost, estimateAudioCost(model, audioDuration));
    }
  }

  return totalCost;
}
