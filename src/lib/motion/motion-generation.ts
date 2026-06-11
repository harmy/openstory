import { getEnv } from '#env';
import { calculateVideoCost } from '@/lib/ai/fal-cost';
import {
  DEFAULT_VIDEO_MODEL,
  IMAGE_TO_VIDEO_MODELS,
  type ImageToVideoModel,
  videoModelSupportsAudio,
} from '@/lib/ai/models';
import type { Microdollars } from '@/lib/billing/money';
import { type AspectRatio } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import { MOTION_JSON_SCHEMAS } from '@/lib/motion/endpoint-map';
import {
  getDurationValues,
  numericOf,
  snapTo,
} from '@/lib/motion/motion-transform';
import { generateVideo, getVideoJobStatus } from '@tanstack/ai';
import { falVideo } from '@tanstack/ai-fal';

export type GenerateMotionOptions = {
  scopedDb?: ScopedDb; // scopedDb is used to resolve the API key for the motion generation with BYOK
  imageUrl: string;
  prompt: string;
  model?: ImageToVideoModel;
  duration?: number;
  fps?: number;
  motionBucket?: number;
  aspectRatio?: AspectRatio;
  /** For audio-capable models (kling v3, veo3), pass `false` to suppress
   *  the model's native audio output (sfx/ambient/lip-sync). Omitting the
   *  flag lets the API schema default apply (true for audio-capable models). */
  generateAudio?: boolean;
};

import { ensureExternallyFetchableUrl } from '@/lib/storage/external-url';
import { buildModelInput } from './build-model-input';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'motion', 'motion-generation']);

/** Snap a requested duration to the nearest valid value for a model.
 *  Reads supported durations from the model's JSON Schema and snaps directly. */
export function snapDuration(
  requested: number | undefined,
  modelKey: ImageToVideoModel
): number {
  const endpointId = IMAGE_TO_VIDEO_MODELS[modelKey].id;
  const jsonSchema = MOTION_JSON_SCHEMAS[endpointId];
  const validValues = getDurationValues(jsonSchema);

  const firstValue = validValues[0];
  if (firstValue === undefined) return requested ?? 5;

  const target = requested ?? numericOf(firstValue);
  return numericOf(snapTo(target, validValues));
}

export type MotionJobSubmission = {
  jobId: string;
  modelKey: ImageToVideoModel;
  usedOwnKey: boolean;
  submittedAt: number;
};

/**
 * Submit a motion generation job without polling.
 * Returns the job ID so the workflow can poll with `context.sleep()` between steps.
 */
export async function submitMotionJob(
  options: GenerateMotionOptions
): Promise<MotionJobSubmission> {
  const modelKey = options.model || DEFAULT_VIDEO_MODEL;
  const modelConfig = IMAGE_TO_VIDEO_MODELS[modelKey];

  // Locally-served /r2/ image URLs aren't reachable by real fal — swap them
  // for a fal-storage upload first (no-op in prod and e2e replay).
  const imageUrl = await ensureExternallyFetchableUrl(options.imageUrl);

  // Prepare the model input
  const modelInput = buildModelInput(
    { ...options, imageUrl },
    modelConfig,
    modelKey
  );

  // Separate the prompt from the model options
  const { prompt: optimisedPrompt, ...modelOptions } = modelInput;
  if (typeof optimisedPrompt !== 'string') {
    throw new Error('Truncated prompt is not a string');
  }
  // Log the submission details
  logger.info(`Submitting job with model: ${modelConfig.id}`, {
    provider: modelConfig.provider,
    promptLength: optimisedPrompt.length,
    modelOptions,
  });

  // Resolve the API key for the motion generation with BYOK if available
  const falApiKeyInfo = options.scopedDb
    ? await options.scopedDb.apiKeys.resolveKey('fal')
    : { key: getEnv().FAL_KEY, source: 'platform' as const };

  // Create the Tanstack AI adapter and submit the job
  // Note this is typesafe - only options compatible with modelConfig.id are allowed
  // Important: fal.ai supports string for model ids that the client doesn't know about - so most new models _aren't_ typesafe
  const job = await generateVideo({
    adapter: falVideo(modelConfig.id, {
      apiKey: falApiKeyInfo.key,
    }),
    prompt: optimisedPrompt,
    modelOptions,
    debug: false,
  });

  // Log the job submission details
  logger.info(`Job submitted: ${job.jobId}`);

  return {
    jobId: job.jobId,
    modelKey,
    usedOwnKey: falApiKeyInfo.source === 'team',
    submittedAt: Date.now(),
  };
}

/**
 * Check the status of a submitted motion job.
 * Designed to be called from individual workflow steps.
 */
export async function pollMotionJob(
  jobId: string,
  modelKey: ImageToVideoModel,
  scopedDb?: ScopedDb
) {
  const modelConfig = IMAGE_TO_VIDEO_MODELS[modelKey];

  // Resolve the API key for the motion generation with BYOK if available
  const falApiKeyInfo = scopedDb
    ? await scopedDb.apiKeys.resolveKey('fal')
    : { key: getEnv().FAL_KEY, source: 'platform' as const };

  // Create the Tanstack AI adapter and poll the job status

  return await getVideoJobStatus({
    adapter: falVideo(modelConfig.id, {
      apiKey: falApiKeyInfo.key,
    }),
    jobId,
  });
}

/**
 * Calculate motion cost + metadata after job completes.
 */
export function calculateMotionMetadata(options: GenerateMotionOptions): {
  cost: Microdollars;
  duration: number;
  model: string;
  provider: string;
} {
  const modelKey = options.model || DEFAULT_VIDEO_MODEL;
  const modelConfig = IMAGE_TO_VIDEO_MODELS[modelKey];

  const validatedDuration = snapDuration(options.duration, modelKey);

  const providerInput = buildModelInput(options, modelConfig, modelKey);
  const audioEnabled =
    videoModelSupportsAudio(modelKey) && options.generateAudio !== false;
  const cost = calculateVideoCost({
    endpointId: modelConfig.id,
    durationSeconds: validatedDuration,
    audioEnabled,
    resolution:
      'resolution' in providerInput &&
      typeof providerInput.resolution === 'string'
        ? providerInput.resolution
        : undefined,
  });

  return {
    cost,
    duration: validatedDuration,
    model: modelConfig.id,
    provider: modelConfig.provider,
  };
}

type FalQueueStatus = {
  status: 'IN_QUEUE' | 'IN_PROGRESS' | 'COMPLETED';
  queue_position?: number;
  response_url?: string;
  cancel_url?: string;
  status_url?: string;
  logs?: Array<{ level: string; message: string }>;
  metrics?: { inference_time?: number };
};

/** Authenticated fetch against the fal queue API */
async function falQueueFetch(
  url: string,
  init?: RequestInit
): Promise<Response> {
  const apiKey = getEnv().FAL_KEY;
  if (!apiKey) {
    throw new Error('FAL_KEY environment variable is required');
  }

  const response = await fetch(url, {
    ...init,
    headers: new Headers({
      Authorization: `Key ${apiKey}`,
      ...Object.fromEntries(new Headers(init?.headers).entries()),
    }),
  });

  if (!response.ok) {
    throw new Error(`Fal API error: ${response.status} ${response.statusText}`);
  }

  return response;
}

export async function checkMotionStatus(
  statusUrl: string
): Promise<FalQueueStatus> {
  const response = await falQueueFetch(statusUrl);
  return response.json();
}

export async function getMotionResult(
  responseUrl: string
): Promise<{ video: { url: string } }> {
  const response = await falQueueFetch(responseUrl);
  return response.json();
}

export async function cancelMotionGeneration(cancelUrl: string): Promise<void> {
  await falQueueFetch(cancelUrl, { method: 'PUT' });
}
