import { getEnv } from '#env';
import { calculateAudioCost } from '@/lib/ai/fal-cost';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import {
  AUDIO_MODEL_KEYS,
  AUDIO_MODELS,
  DEFAULT_MUSIC_MODEL,
  type AudioModel,
  type AudioModelConfig,
} from '@/lib/ai/models';
import { microsToUsd, type Microdollars } from '@/lib/billing/money';
import type { ScopedDb } from '@/lib/db/scoped';
import { createFalClient } from '@fal-ai/client';
import {
  endSpanError,
  endSpanSuccess,
  startGenAISpan,
} from '@/lib/observability/tracer';
import { z } from 'zod';

export const generateMusicOptionsSchema = z.object({
  prompt: z.string().min(1),
  tags: z.string().optional(),
  lyrics: z.string().optional(),
  duration: z.number().min(1).max(240).optional(),
  instrumental: z.boolean().optional().default(true),
  model: z.enum(AUDIO_MODEL_KEYS).optional().default(DEFAULT_MUSIC_MODEL),
  steps: z.number().optional(),
});

export type GenerateMusicOptions = {
  scopedDb?: ScopedDb;
  /** Style/mood prompt for the music (e.g., "tense orchestral, dark atmosphere") */
  prompt: string;
  /** Comma-separated genre tags (e.g., "orchestral, ambient, cinematic") */
  tags?: string;
  /** Lyrics with [verse], [chorus], [bridge] structure. Use [inst] for instrumental. */
  lyrics?: string;
  /** Duration in seconds (1-240, default: 60) */
  duration?: number;
  /** Generate instrumental only (default: true) */
  instrumental?: boolean;
  model?: AudioModel;
  /** Number of diffusion steps (default: 27) */
  steps?: number;
  traceName?: string;
};

export type MusicResult = {
  success: boolean;
  audioUrl?: string;
  metadata: {
    model: string;
    provider: string;
    duration: number;
    cost: Microdollars;
    generatedAt: string;
    usedOwnKey: boolean;
  };
  error?: string;
  requestId?: string;
};

function clampDuration(
  requested: number | undefined,
  config: AudioModelConfig
): number {
  if (!requested) return config.capabilities.defaultDuration;
  return Math.min(requested, config.capabilities.maxDuration);
}

type AudioInputBuilder = (
  options: GenerateMusicOptions,
  config: AudioModelConfig
) => Record<string, unknown>;

const AUDIO_INPUT_BUILDERS: Partial<Record<AudioModel, AudioInputBuilder>> = {
  ace_step: (options, config) => {
    const lyrics =
      options.instrumental && !options.lyrics
        ? '[inst]'
        : (options.lyrics ?? '[inst]');

    return {
      prompt: options.tags ?? options.prompt,
      lyrics,
      duration: clampDuration(options.duration, config),
      instrumental: options.instrumental ?? true,
      number_of_steps: options.steps ?? 27,
      scheduler: 'euler',
      guidance_type: 'apg',
    };
  },

  elevenlabs_music: (options, config) => ({
    prompt: options.prompt,
    music_length_ms: clampDuration(options.duration, config) * 1000,
    force_instrumental: options.instrumental ?? true,
  }),

  minimax_music_v2: (options, config) => ({
    prompt: options.prompt,
    duration: clampDuration(options.duration, config),
  }),

  lyria_2: (options, config) => ({
    prompt: options.prompt,
    duration: clampDuration(options.duration, config),
  }),
};

/**
 * Extract audio URL from fal.ai response data.
 * Models return audio in different shapes: `audio_file.url` or `audio.url`.
 */
function hasKey<K extends string>(
  obj: object,
  key: K
): obj is Record<K, unknown> {
  return key in obj;
}

function extractAudioUrl(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  for (const key of ['audio_file', 'audio'] as const) {
    if (!hasKey(data, key)) continue;
    const field = data[key];
    if (typeof field === 'object' && field !== null && hasKey(field, 'url')) {
      if (typeof field.url === 'string') return field.url;
    }
  }
  return undefined;
}

/**
 * Generate music/audio using Fal.ai with queue-based status tracking.
 */
export async function generateMusic(
  options: GenerateMusicOptions
): Promise<MusicResult> {
  const modelKey = options.model || DEFAULT_MUSIC_MODEL;
  const modelConfig = AUDIO_MODELS[modelKey];

  const span = startGenAISpan(options.traceName ?? 'fal-music', {
    model: modelKey,
    provider: 'fal',
    operation: 'generate_content',
    input: {
      prompt: options.prompt,
      tags: options.tags,
      duration: options.duration,
      instrumental: options.instrumental,
    },
  });

  try {
    const result = await callFalAudio(options, modelConfig);

    if (result.metadata.cost) {
      span.setAttribute('gen_ai.usage.cost', microsToUsd(result.metadata.cost));
    }
    endSpanSuccess(span, { audioUrl: result.audioUrl });

    return result;
  } catch (error) {
    endSpanError(span, extractFalErrorMessage(error));
    throw error;
  }
}

async function callFalAudio(
  options: GenerateMusicOptions,
  modelConfig: AudioModelConfig
): Promise<MusicResult> {
  const modelKey = options.model || DEFAULT_MUSIC_MODEL;
  const inputBuilder = AUDIO_INPUT_BUILDERS[modelKey];
  if (!inputBuilder) {
    throw new Error(`No input builder for audio model: ${modelKey}`);
  }

  const input = inputBuilder(options, modelConfig);

  console.log(
    `[Music Service] Generating music with model: ${modelConfig.id}`,
    {
      provider: modelConfig.provider,
      promptLength: options.prompt.length,
      duration: input.duration,
    }
  );

  const falApiKeyInfo = options.scopedDb
    ? await options.scopedDb.apiKeys.resolveKey('fal')
    : { key: getEnv().FAL_KEY, source: 'platform' as const };
  const fal = createFalClient({
    credentials: falApiKeyInfo.key,
  });

  const result = await fal.subscribe(modelConfig.id, {
    input,
    logs: true,
    pollInterval: 5000,
    onEnqueue: (reqId: string) => {
      console.log(`[Music Service] Request enqueued: ${reqId}`);
    },
    onQueueUpdate: (update) => {
      if (update.status === 'IN_QUEUE' && 'queue_position' in update) {
        console.log(`[Music Service] Queue position: ${update.queue_position}`);
      } else if (update.status === 'IN_PROGRESS') {
        console.log(`[Music Service] Generation in progress...`);
      } else {
        console.log(
          `[Music Service] Completed in ${update.metrics?.inference_time || 'unknown'}s`
        );
      }
    },
  });

  const audioUrl = extractAudioUrl(result.data);

  if (!audioUrl) {
    console.error('[Music Service] No audio URL in result:', result);
    throw new Error('No audio URL returned from music generation');
  }

  const duration = options.duration ?? modelConfig.capabilities.defaultDuration;
  const cost = calculateAudioCost({
    endpointId: modelConfig.id,
    durationSeconds: duration,
  });

  return {
    success: true,
    audioUrl,
    requestId: result.requestId,
    metadata: {
      model: modelConfig.id,
      provider: modelConfig.provider,
      duration,
      cost,
      generatedAt: new Date().toISOString(),
      usedOwnKey: falApiKeyInfo.source === 'team',
    },
  };
}
