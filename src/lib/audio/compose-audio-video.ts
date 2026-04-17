/**
 * Compose Audio+Video Service
 * Combines video (preserving native audio) with a music track using fal.ai's ffmpeg compose API.
 * Unlike merge-audio-video which replaces video audio, compose mixes both audio sources together.
 */

import { createFalClient } from '@fal-ai/client';
import type { QueueStatus } from '@fal-ai/client';
import { getEnv } from '#env';
import type { ScopedDb } from '@/lib/db/scoped';

const COMPOSE_MODEL_ID = 'fal-ai/ffmpeg-api/compose';

/** Compose API input/output types (not re-exported from @fal-ai/client) */
type ComposeKeyframe = { url: string; timestamp: number; duration: number };
type ComposeTrack = {
  id: string;
  type: string;
  keyframes: ComposeKeyframe[];
};
type ComposeInput = { tracks: ComposeTrack[] };

export type ComposeAudioVideoResult = {
  videoUrl: string;
  requestId?: string;
  cost: number;
  usedOwnKey: boolean;
};

/**
 * Compose a video (with its native audio preserved) and a music track into a single output.
 * The video track keeps its original audio (SFX, ambient, dialogue) while the music
 * track is mixed on top. This is ideal for videos from audio-capable models (veo3, kling v3).
 */
export async function composeAudioVideo({
  videoUrl,
  musicUrl,
  durationMs,
  scopedDb,
}: {
  videoUrl: string;
  musicUrl: string;
  durationMs: number;
  scopedDb?: ScopedDb; // scopedDb is used to resolve the API key for the compose audio video with BYOK
}): Promise<ComposeAudioVideoResult> {
  console.log('[ComposeAudioVideo] Composing video with music track', {
    videoUrl: videoUrl.slice(0, 80),
    musicUrl: musicUrl.slice(0, 80),
    durationMs,
  });

  const falApiKeyInfo = scopedDb
    ? await scopedDb.apiKeys.resolveKey('fal')
    : { key: getEnv().FAL_KEY, source: 'platform' as const };
  const fal = createFalClient({
    credentials: falApiKeyInfo.key,
  });

  const dur = durationMs;

  const input: ComposeInput = {
    tracks: [
      {
        id: 'video',
        type: 'video',
        keyframes: [{ url: videoUrl, timestamp: 0, duration: dur }],
      },
      {
        id: 'native-audio',
        type: 'audio',
        keyframes: [{ url: videoUrl, timestamp: 0, duration: dur }],
      },
      {
        id: 'music',
        type: 'audio',
        keyframes: [{ url: musicUrl, timestamp: 0, duration: dur }],
      },
    ],
  };

  let requestId: string | undefined;

  const result = await fal.subscribe(COMPOSE_MODEL_ID, {
    input,
    logs: true,
    pollInterval: 5000,
    onEnqueue: (reqId: string) => {
      requestId = reqId;
      console.log(`[ComposeAudioVideo] Request enqueued: ${reqId}`);
    },
    onQueueUpdate: (update: QueueStatus) => {
      if (update.status === 'IN_QUEUE' && 'queue_position' in update) {
        console.log(
          `[ComposeAudioVideo] Queue position: ${update.queue_position}`
        );
      }
      if (update.status === 'COMPLETED') {
        console.log(
          `[ComposeAudioVideo] Completed in ${update.metrics?.inference_time || 'unknown'}s`
        );
      }
    },
  });

  const outputUrl =
    typeof result.data === 'object' && 'video_url' in result.data
      ? result.data.video_url
      : undefined;

  if (!outputUrl || typeof outputUrl !== 'string') {
    throw new Error('No video URL returned from compose operation');
  }

  let cost = 0;
  if (
    'metadata' in result &&
    result.metadata &&
    typeof result.metadata === 'object'
  ) {
    const meta = result.metadata;
    if ('cost' in meta && typeof meta.cost === 'number') {
      cost = meta.cost;
    }
  }

  return {
    videoUrl: outputUrl,
    requestId: requestId ?? result.requestId,
    cost,
    usedOwnKey: falApiKeyInfo.source === 'team',
  };
}
