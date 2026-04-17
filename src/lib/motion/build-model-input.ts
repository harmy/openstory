/**
 * Schema-Driven Model Input Builder
 *
 * Builds the fal.ai request body for a video model using generated
 * Zod transforms. Each transform accepts our internal camelCase format
 * (numeric duration, imageUrl) and produces the API's snake_case format
 * with correctly-typed duration values.
 */

import type { IMAGE_TO_VIDEO_MODELS, ImageToVideoModel } from '@/lib/ai/models';
import type { z } from 'zod';
import { MOTION_TRANSFORMS } from './endpoint-map';
import type { GenerateMotionOptions } from './motion-generation';
/** Intentional deviations from API defaults */
const QUALITY_OVERRIDES: Partial<
  Record<ImageToVideoModel, Record<string, unknown>>
> = {
  veo3_1: { resolution: '1080p' },
  seedance_v1_5_pro: { resolution: '1080p' },
  seedance_v2: { resolution: '720p' },
};

type ModelOutputMap = {
  [K in ImageToVideoModel]: z.output<
    (typeof MOTION_TRANSFORMS)[(typeof IMAGE_TO_VIDEO_MODELS)[K]['id']]
  >;
};

export function buildModelInput<T extends ImageToVideoModel>(
  options: GenerateMotionOptions,
  modelConfig: (typeof IMAGE_TO_VIDEO_MODELS)[T],
  modelKey: T
): ModelOutputMap[T] {
  const endpointId: (typeof IMAGE_TO_VIDEO_MODELS)[T]['id'] = modelConfig.id;
  const transform = MOTION_TRANSFORMS[endpointId];
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- defensive guard for exhaustiveness
  if (!transform) {
    throw new Error(
      `No motion transform registered for endpoint: ${endpointId}`
    );
  }
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion safe to cast here because we know the transform is valid
  const result = transform.parse({
    prompt: options.prompt,
    duration: options.duration,
    imageUrl: options.imageUrl,
    aspectRatio: options.aspectRatio,
    ...QUALITY_OVERRIDES[modelKey],
  }) as ModelOutputMap[T];

  const outputPrompt =
    'prompt' in result && typeof result.prompt === 'string'
      ? result.prompt
      : '';
  const truncated = outputPrompt.length < options.prompt.length;

  console.log(
    `[buildModelInput] model=${modelKey} inputLen=${options.prompt.length} outputLen=${outputPrompt.length} truncated=${truncated}`
  );
  if (truncated) {
    console.log(`[buildModelInput] INPUT prompt:\n${options.prompt}`);
    console.log(`[buildModelInput] OUTPUT prompt:\n${outputPrompt}`);
  }

  return result;
}
