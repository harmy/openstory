/**
 * On-demand MP4 export. Shares `ConcatenatedVideoSource` with the live player
 * so the two stay in lock-step — same iterator, same scene timing, same
 * loudness gain. The only difference from playback is the sink:
 *
 * - Live player: video → `CanvasSink`, music → `AudioBufferSink` → `GainNode`.
 * - Export:      video → `EncodedVideoPacketSource`, music → mixed in an
 *                `OfflineAudioContext` → AAC → `EncodedAudioPacketSource`.
 *
 * The result is an in-memory MP4 `Blob` ready to upload to R2 via the
 * `sequence_exports` server functions.
 */

import {
  ALL_FORMATS,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedVideoPacketSource,
  Input,
  Mp4OutputFormat,
  Output,
  UrlSource,
} from 'mediabunny';
import { addCorsCacheBuster } from '@/lib/utils/cors-cache-buster';

import {
  applyGain,
  DEFAULT_MUSIC_LOUDNESS_LUFS,
  gainToTarget,
  integratedLoudnessLUFS,
} from '@/lib/browser-merge';

import {
  ConcatenatedVideoSource,
  type SceneInput,
} from './concatenated-video-source';

const MAX_TOTAL_DURATION_SECONDS = 5 * 60;
const TARGET_SAMPLE_RATE = 48_000;
const TARGET_CHANNELS = 2;
const AAC_BITRATE = 192_000;

export type ExportProgressPhase =
  | 'prepare'
  | 'video'
  | 'music'
  | 'mix'
  | 'encode'
  | 'finalize';

export type ExportProgress = {
  phase: ExportProgressPhase;
  completed: number;
  total: number;
};

export type ExportProgressCallback = (progress: ExportProgress) => void;

export type ExportSequenceInput = {
  scenes: SceneInput[];
  musicUrl: string | null;
  /**
   * Precomputed gain in dB to apply to music. `null` triggers an in-process
   * EBU R128 measurement (slower but accurate) so live playback and export
   * remain consistent in loudness even when the column hasn't been backfilled.
   */
  musicLoudnessGainDb: number | null;
  onProgress?: ExportProgressCallback;
  signal?: AbortSignal;
};

export type ExportSequenceResult = {
  blob: Blob;
  durationSeconds: number;
};

export async function exportSequence(
  input: ExportSequenceInput
): Promise<ExportSequenceResult> {
  const { scenes, musicUrl, musicLoudnessGainDb, onProgress, signal } = input;

  const videoSource = new ConcatenatedVideoSource(scenes);
  let musicInput: Input | null = null;

  try {
    const meta = await videoSource.prepare();
    onProgress?.({ phase: 'prepare', completed: 1, total: 1 });

    if (meta.totalDurationSeconds > MAX_TOTAL_DURATION_SECONDS) {
      throw new Error(
        `Sequence is ${meta.totalDurationSeconds.toFixed(1)}s long; browser export currently caps at ${MAX_TOTAL_DURATION_SECONDS}s.`
      );
    }

    const output = new Output({
      format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
      target: new BufferTarget(),
    });
    const videoSrc = new EncodedVideoPacketSource('avc');
    output.addVideoTrack(videoSrc);

    const audioSrc = musicUrl ? new EncodedAudioPacketSource('aac') : null;
    if (audioSrc) output.addAudioTrack(audioSrc);

    await output.start();

    try {
      // VIDEO: transmux packets from each scene, with global timestamps.
      let packetCount = 0;
      for await (const { packet, decoderConfig } of videoSource.packets({
        signal,
      })) {
        if (signal?.aborted) throw new Error('Export aborted');
        await videoSrc.add(
          packet,
          decoderConfig ? { decoderConfig } : undefined
        );
        packetCount++;
        if (packetCount % 30 === 0) {
          onProgress?.({
            phase: 'video',
            completed: packetCount,
            total: 0,
          });
        }
      }
      onProgress?.({
        phase: 'video',
        completed: packetCount,
        total: packetCount,
      });

      // MUSIC: fetch + mix at loudness gain + encode AAC.
      if (musicUrl && audioSrc) {
        if (signal?.aborted) throw new Error('Export aborted');
        const bustedMusicUrl = addCorsCacheBuster(musicUrl);
        const musicBlob = await fetchBlob(bustedMusicUrl, signal);
        onProgress?.({ phase: 'music', completed: 1, total: 1 });

        musicInput = new Input({
          formats: ALL_FORMATS,
          source: new UrlSource(bustedMusicUrl),
        });

        const mixed = await mixMusic({
          musicBlob,
          totalDurationSeconds: meta.totalDurationSeconds,
          musicLoudnessGainDb,
          signal,
        });
        onProgress?.({ phase: 'mix', completed: 1, total: 1 });

        await encodeAacAndPushPackets({
          mixed,
          audioSrc,
          onProgress: (completed, total) =>
            onProgress?.({ phase: 'encode', completed, total }),
          signal,
        });
      }

      if (signal?.aborted) throw new Error('Export aborted');
      await output.finalize();
      onProgress?.({ phase: 'finalize', completed: 1, total: 1 });

      const buffer = output.target.buffer;
      if (!buffer) {
        throw new Error('Mediabunny finalize produced no buffer');
      }
      return {
        blob: new Blob([buffer], { type: 'video/mp4' }),
        durationSeconds: meta.totalDurationSeconds,
      };
    } catch (error) {
      await output.cancel().catch(() => {});
      throw error;
    }
  } finally {
    videoSource.dispose();
    if (musicInput) musicInput.dispose();
  }
}

async function fetchBlob(url: string, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(url, { signal });
  if (!response.ok) {
    throw new Error(
      `Failed to fetch ${url}: ${response.status} ${response.statusText}`
    );
  }
  return await response.blob();
}

async function mixMusic(args: {
  musicBlob: Blob;
  totalDurationSeconds: number;
  musicLoudnessGainDb: number | null;
  signal?: AbortSignal;
}): Promise<AudioBuffer> {
  const { musicBlob, totalDurationSeconds, musicLoudnessGainDb, signal } = args;

  const decodeCtx = new AudioContext();
  let normalized: AudioBuffer;
  try {
    const arrayBuffer = await musicBlob.arrayBuffer();
    const decoded = await decodeCtx.decodeAudioData(arrayBuffer);
    if (signal?.aborted) throw new Error('Export aborted');

    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      channels.push(decoded.getChannelData(c).slice());
    }

    // Prefer the precomputed gain so playback and export are bit-identical
    // in loudness. Fall back to measuring if the column hasn't been backfilled.
    const gainLinear =
      musicLoudnessGainDb !== null && Number.isFinite(musicLoudnessGainDb)
        ? Math.pow(10, musicLoudnessGainDb / 20)
        : gainToTarget(
            integratedLoudnessLUFS(channels, decoded.sampleRate),
            DEFAULT_MUSIC_LOUDNESS_LUFS
          );
    applyGain(channels, gainLinear);

    normalized = new AudioBuffer({
      length: decoded.length,
      numberOfChannels: decoded.numberOfChannels,
      sampleRate: decoded.sampleRate,
    });
    for (let c = 0; c < channels.length; c++) {
      const channel = channels[c];
      if (!channel) throw new Error(`expected channel ${c}`);
      normalized.copyToChannel(toArrayBufferBacked(channel), c);
    }
  } finally {
    await decodeCtx.close();
  }

  const length = Math.max(
    1,
    Math.ceil(totalDurationSeconds * TARGET_SAMPLE_RATE)
  );
  const offline = new OfflineAudioContext({
    numberOfChannels: TARGET_CHANNELS,
    length,
    sampleRate: TARGET_SAMPLE_RATE,
  });
  const src = offline.createBufferSource();
  src.buffer = normalized;
  src.connect(offline.destination);
  src.start(0);
  return await offline.startRendering();
}

function toArrayBufferBacked(input: Float32Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(input.length);
  out.set(input);
  return out;
}

async function encodeAacAndPushPackets(args: {
  mixed: AudioBuffer;
  audioSrc: EncodedAudioPacketSource;
  onProgress?: (completed: number, total: number) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const { mixed, audioSrc, onProgress, signal } = args;
  const sampleRate = mixed.sampleRate;
  const numberOfChannels = mixed.numberOfChannels;
  const totalFrames = mixed.length;
  const chunkFrames = 1024;
  const totalChunks = Math.ceil(totalFrames / chunkFrames);

  const channelData: Float32Array[] = [];
  for (let c = 0; c < numberOfChannels; c++) {
    channelData.push(mixed.getChannelData(c));
  }

  let firstPacketEmitted = false;
  const pendingAdds: Promise<void>[] = [];
  let encoderError: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk: EncodedAudioChunk, meta?: EncodedAudioChunkMetadata) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      if (!firstPacketEmitted) {
        firstPacketEmitted = true;
        pendingAdds.push(audioSrc.add(packet, meta));
      } else {
        pendingAdds.push(audioSrc.add(packet));
      }
    },
    error: (e: DOMException) => {
      encoderError = e instanceof Error ? e : new Error(String(e));
    },
  });
  encoder.configure({
    codec: 'mp4a.40.2',
    sampleRate,
    numberOfChannels,
    bitrate: AAC_BITRATE,
  });

  for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
    if (signal?.aborted) throw new Error('Export aborted');
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- mutated by WebCodecs error callback
    if (encoderError) throw encoderError;

    const start = chunkIndex * chunkFrames;
    const end = Math.min(start + chunkFrames, totalFrames);
    const frames = end - start;

    const interleaved = new Float32Array(frames * numberOfChannels);
    for (let c = 0; c < numberOfChannels; c++) {
      const channel = channelData[c];
      if (!channel) throw new Error(`expected channel ${c}`);
      for (let f = 0; f < frames; f++) {
        interleaved[f * numberOfChannels + c] = channel[start + f] ?? 0;
      }
    }

    const audioData = new AudioData({
      format: 'f32',
      sampleRate,
      numberOfFrames: frames,
      numberOfChannels,
      timestamp: Math.round((start / sampleRate) * 1_000_000),
      data: interleaved,
    });
    encoder.encode(audioData);
    audioData.close();

    if (chunkIndex % 50 === 0) {
      onProgress?.(chunkIndex + 1, totalChunks);
    }
  }

  await encoder.flush();
  encoder.close();
  // oxlint-disable-next-line typescript/no-unnecessary-condition -- mutated by WebCodecs error callback
  if (encoderError) throw encoderError;
  await Promise.all(pendingAdds);
  onProgress?.(totalChunks, totalChunks);
}
