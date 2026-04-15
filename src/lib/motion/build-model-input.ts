/**
 * Schema-Driven Model Input Builder
 *
 * Builds the fal.ai request body for a video model using generated
 * Zod transforms. Each transform accepts our internal camelCase format
 * (numeric duration, imageUrl) and produces the API's snake_case format
 * with correctly-typed duration values.
 */

import type {
  ImageToVideoModel,
  ImageToVideoModelConfig,
} from '@/lib/ai/models';
import { MOTION_TRANSFORMS, type MotionEndpointId } from './endpoint-map';
import type { GenerateMotionOptions } from './motion-generation';

/** Intentional deviations from API defaults */
const QUALITY_OVERRIDES: Partial<
  Record<ImageToVideoModel, Record<string, unknown>>
> = {
  veo3_1: { resolution: '1080p' },
  seedance_v1_5_pro: { resolution: '1080p' },
  seedance_v2: { resolution: '720p' },
};

export function buildModelInput(
  options: GenerateMotionOptions,
  modelConfig: ImageToVideoModelConfig,
  modelKey: ImageToVideoModel
) {
  const endpointId = modelConfig.id satisfies MotionEndpointId;
  const transform = MOTION_TRANSFORMS[endpointId];

  const result = transform.parse({
    prompt: options.prompt,
    duration: options.duration,
    imageUrl: options.imageUrl,
    aspectRatio: options.aspectRatio,
    ...QUALITY_OVERRIDES[modelKey],
  });

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
