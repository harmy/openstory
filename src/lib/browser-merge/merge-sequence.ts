/**
 * Top-level browser-merge orchestrator. Given the public R2 URLs of every
 * scene video (in order) plus a single music URL, produces a Blob containing
 * a finalized MP4 (H.264 + AAC) ready to upload to R2.
 *
 * Hard-caps total duration at 5 minutes for the first cut — past that point,
 * BufferTarget memory pressure can OOM mobile browsers. A future iteration
 * can switch to StreamTarget piped directly into the presigned upload.
 */

import {
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedVideoPacketSource,
  Mp4OutputFormat,
  Output,
} from 'mediabunny';

import { concatVideoTracks } from './concat-video-tracks';
import { mixAndEncodeAudio } from './mix-audio-tracks';
import { probeBrowserMergeCapabilities } from './probe';
import type {
  MergeProgressCallback,
  MergeSequenceInput,
  MergeSequenceResult,
} from './types';

const MAX_TOTAL_DURATION_SECONDS = 5 * 60;

export async function mergeSequence(
  input: MergeSequenceInput
): Promise<MergeSequenceResult> {
  await probeBrowserMergeCapabilities();

  const orderedScenes = [...input.scenes].sort(
    (a, b) => a.orderIndex - b.orderIndex
  );

  const sceneBlobs = await fetchAll(
    orderedScenes.map((s) => s.videoUrl),
    'fetch',
    sceneCount(orderedScenes.length, input.musicUrl ? 1 : 0),
    input.onProgress,
    input.signal
  );

  let musicBlob: Blob | null = null;
  if (input.musicUrl) {
    musicBlob = await fetchOne(input.musicUrl, input.signal);
    input.onProgress?.({
      phase: 'fetch',
      completed: orderedScenes.length + 1,
      total: orderedScenes.length + 1,
    });
  }

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const videoSrc = new EncodedVideoPacketSource('avc');
  const audioSrc = new EncodedAudioPacketSource('aac');
  output.addVideoTrack(videoSrc);
  output.addAudioTrack(audioSrc);

  await output.start();

  try {
    const concatResult = await concatVideoTracks({
      sceneBlobs,
      videoSrc,
      onProgress: ({ sceneIndex, totalScenes }) => {
        input.onProgress?.({
          phase: 'decode',
          completed: sceneIndex,
          total: totalScenes,
        });
      },
      signal: input.signal,
    });

    if (concatResult.totalDurationSeconds > MAX_TOTAL_DURATION_SECONDS) {
      throw new Error(
        `Sequence is ${concatResult.totalDurationSeconds.toFixed(1)}s long; browser merge currently caps at ${MAX_TOTAL_DURATION_SECONDS}s. Try a shorter sequence or contact support.`
      );
    }

    const sceneOffsetsSeconds: number[] = [];
    let acc = 0;
    for (const dur of concatResult.sceneDurationsSeconds) {
      sceneOffsetsSeconds.push(acc);
      acc += dur;
    }

    await mixAndEncodeAudio({
      sceneBlobs,
      sceneOffsetsSeconds,
      totalDurationSeconds: concatResult.totalDurationSeconds,
      musicBlob,
      audioSrc,
      onProgress: (p) => {
        const phase = p.phase === 'encode' ? 'encode' : 'mix';
        input.onProgress?.({
          phase,
          completed: p.completed,
          total: p.total,
        });
      },
      signal: input.signal,
    });

    if (input.signal?.aborted) throw new Error('Browser merge aborted');

    await output.finalize();
    input.onProgress?.({ phase: 'finalize', completed: 1, total: 1 });

    const buffer = output.target.buffer;
    if (!buffer) {
      throw new Error('Mediabunny finalize produced no buffer');
    }

    return {
      blob: new Blob([buffer], { type: 'video/mp4' }),
      durationSeconds: concatResult.totalDurationSeconds,
    };
  } catch (error) {
    await output.cancel().catch(() => {});
    throw error;
  }
}

async function fetchAll(
  urls: string[],
  phase: 'fetch',
  totalSteps: number,
  onProgress: MergeProgressCallback | undefined,
  signal: AbortSignal | undefined
): Promise<Blob[]> {
  const blobs: Blob[] = [];
  for (let i = 0; i < urls.length; i++) {
    if (signal?.aborted) throw new Error('Browser merge aborted');
    blobs.push(await fetchOne(urls[i], signal));
    onProgress?.({ phase, completed: i + 1, total: totalSteps });
  }
  return blobs;
}

async function fetchOne(url: string, signal?: AbortSignal): Promise<Blob> {
  // Cache-busting: the same R2 URLs are also rendered as `<video src>` on
  // other views, which causes the Cloudflare edge to cache the response
  // *without* `Vary: Origin` (because the original request had no Origin
  // header). When fetch() then sends an Origin header for the same URL, the
  // edge serves the cached non-CORS response and the browser blocks it.
  // A unique query param forces a separate cache key + a fresh fetch with
  // CORS headers attached. `cache: 'no-store'` also bypasses the local HTTP
  // cache so we don't pick up a stale entry the browser saved earlier.
  const bustedUrl = appendCacheBuster(url);
  const response = await fetch(bustedUrl, { signal, cache: 'no-store' });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`
    );
  }
  return await response.blob();
}

function sceneCount(scenes: number, musicCount: number): number {
  return scenes + musicCount;
}

function appendCacheBuster(url: string): string {
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}_bm=1`;
}
