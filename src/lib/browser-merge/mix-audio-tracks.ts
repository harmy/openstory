/**
 * Audio mix pipeline:
 * 1. Decode each scene's audio track to PCM (per-scene buffers).
 * 2. Decode the music URL to PCM via `AudioContext.decodeAudioData`.
 * 3. Loudness-normalize the music to DEFAULT_MUSIC_LOUDNESS_LUFS (−24 LUFS).
 * 4. Mix scenes (placed at scene-offset on the timeline) + music in an
 *    OfflineAudioContext at 48 kHz / stereo.
 * 5. Re-encode the mixed master to AAC and stream EncodedPackets into the
 *    output's `EncodedAudioPacketSource`.
 *
 * Native scene audio is preserved (e.g. for models that return voice or
 * ambient sound). For models that return silence, mixing a silent buffer is
 * a no-op and parity with the server-side three-track compose is preserved.
 */

import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacket,
  EncodedPacketSink,
  Input,
  type EncodedAudioPacketSource,
} from 'mediabunny';

import {
  applyGain,
  DEFAULT_MUSIC_LOUDNESS_LUFS,
  gainToTarget,
  integratedLoudnessLUFS,
} from './loudness-normalize';

const TARGET_SAMPLE_RATE = 48_000;
const TARGET_CHANNELS = 2;
const AAC_BITRATE = 192_000;

export type AudioMixProgress = {
  phase: 'decode-scenes' | 'decode-music' | 'mix' | 'encode';
  completed: number;
  total: number;
};

export async function mixAndEncodeAudio(args: {
  sceneBlobs: Blob[];
  sceneOffsetsSeconds: number[];
  totalDurationSeconds: number;
  musicBlob: Blob | null;
  audioSrc: EncodedAudioPacketSource;
  onProgress?: (p: AudioMixProgress) => void;
  signal?: AbortSignal;
}): Promise<void> {
  const {
    sceneBlobs,
    sceneOffsetsSeconds,
    totalDurationSeconds,
    musicBlob,
    audioSrc,
    onProgress,
    signal,
  } = args;

  if (sceneBlobs.length !== sceneOffsetsSeconds.length) {
    throw new Error(
      'mixAndEncodeAudio: sceneBlobs and sceneOffsetsSeconds must align'
    );
  }

  const sceneBuffers: Array<AudioBuffer | null> = [];
  for (let i = 0; i < sceneBlobs.length; i++) {
    if (signal?.aborted) throw new Error('Browser merge aborted');
    const buffer = await decodeSceneAudio(sceneBlobs[i], i);
    sceneBuffers.push(buffer);
    onProgress?.({
      phase: 'decode-scenes',
      completed: i + 1,
      total: sceneBlobs.length,
    });
  }

  let normalizedMusicBuffer: AudioBuffer | null = null;
  if (musicBlob) {
    if (signal?.aborted) throw new Error('Browser merge aborted');
    normalizedMusicBuffer = await decodeAndNormalizeMusic(musicBlob);
    onProgress?.({ phase: 'decode-music', completed: 1, total: 1 });
  }

  if (signal?.aborted) throw new Error('Browser merge aborted');
  const mixed = await mixToOffline({
    sceneBuffers,
    sceneOffsetsSeconds,
    totalDurationSeconds,
    musicBuffer: normalizedMusicBuffer,
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

async function decodeSceneAudio(
  blob: Blob,
  sceneIndex: number
): Promise<AudioBuffer | null> {
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(blob),
  });
  const audioTrack = await input.getPrimaryAudioTrack();
  if (!audioTrack) return null;

  const decoderConfig = await audioTrack.getDecoderConfig();
  if (!decoderConfig) {
    throw new Error(
      `Scene ${sceneIndex} has an audio track but no decoder config`
    );
  }

  const sampleRate = await audioTrack.getSampleRate();
  const numberOfChannels = Math.max(1, await audioTrack.getNumberOfChannels());

  const decoded: AudioData[] = [];
  // WebCodecs invokes `error` async on its own task; throwing from the callback
  // does NOT reject the surrounding `await flush()`. Capture and rethrow.
  let decoderError: Error | null = null;
  const decoder = new AudioDecoder({
    output: (data) => decoded.push(data),
    error: (e) => {
      decoderError = e instanceof Error ? e : new Error(String(e));
    },
  });
  decoder.configure(decoderConfig);

  const sink = new EncodedPacketSink(audioTrack);
  for await (const packet of sink.packets()) {
    if (decoderError) throw decoderError;
    decoder.decode(packet.toEncodedAudioChunk());
  }
  await decoder.flush();
  decoder.close();
  if (decoderError) throw decoderError;

  const { channelData, totalFrames } = assembleChannelData(
    decoded,
    numberOfChannels
  );
  if (totalFrames === 0) {
    throw new Error(
      `Scene ${sceneIndex} audio decoder produced zero frames; the source MP4 may be corrupt`
    );
  }

  const buffer = new AudioBuffer({
    length: totalFrames,
    numberOfChannels,
    sampleRate,
  });
  for (let c = 0; c < numberOfChannels; c++) {
    buffer.copyToChannel(toArrayBufferBacked(channelData[c]), c);
  }
  return buffer;
}

/**
 * Channel-buffer assembly from decoded AudioData frames. Sizing is from the
 * actual frame count, NOT the muxed track duration: AAC priming/padding makes
 * the decoder emit ~2k more frames than `computeDuration` reports, and sizing
 * from duration overflows the typed array (`Float32Array.set` throws "offset
 * is out of bounds" once the write cursor passes the pre-allocated length).
 *
 * Exposed so the priming/padding-overflow regression has a unit test that
 * exercises the actual production code path.
 */
type DecodedAudioFrame = {
  readonly numberOfFrames: number;
  readonly numberOfChannels: number;
  copyTo(
    dest: Float32Array,
    opts: { planeIndex: number; format: 'f32-planar' }
  ): void;
  close(): void;
};

export function assembleChannelData(
  decoded: ReadonlyArray<DecodedAudioFrame>,
  numberOfChannels: number
): { channelData: Float32Array[]; totalFrames: number } {
  let totalFrames = 0;
  for (const data of decoded) totalFrames += data.numberOfFrames;

  const channelData: Float32Array[] = [];
  for (let c = 0; c < numberOfChannels; c++) {
    channelData.push(new Float32Array(totalFrames));
  }

  let writeOffsetSamples = 0;
  for (const data of decoded) {
    const frames = data.numberOfFrames;
    for (
      let c = 0;
      c < Math.min(numberOfChannels, data.numberOfChannels);
      c++
    ) {
      const tmp = new Float32Array(frames);
      data.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
      channelData[c].set(tmp, writeOffsetSamples);
    }
    writeOffsetSamples += frames;
    data.close();
  }

  return { channelData, totalFrames };
}

async function decodeAndNormalizeMusic(blob: Blob): Promise<AudioBuffer> {
  // Decode whatever container/codec the music endpoint returned (MP3, M4A, …)
  // via `AudioContext.decodeAudioData`. Browser-merge already gates on
  // WebCodecs (Safari 16.4+), so vendor-prefixed `webkitAudioContext` is not
  // needed here.
  const decodeCtx = new AudioContext();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const decoded = await decodeCtx.decodeAudioData(arrayBuffer);

    const channels: Float32Array[] = [];
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      channels.push(decoded.getChannelData(c).slice());
    }
    const lufs = integratedLoudnessLUFS(channels, decoded.sampleRate);
    const gain = gainToTarget(lufs, DEFAULT_MUSIC_LOUDNESS_LUFS);
    applyGain(channels, gain);

    const normalized = new AudioBuffer({
      length: decoded.length,
      numberOfChannels: decoded.numberOfChannels,
      sampleRate: decoded.sampleRate,
    });
    for (let c = 0; c < channels.length; c++) {
      normalized.copyToChannel(toArrayBufferBacked(channels[c]), c);
    }
    return normalized;
  } finally {
    await decodeCtx.close();
  }
}

/**
 * AudioBuffer.copyToChannel requires `Float32Array<ArrayBuffer>` specifically;
 * Float32Arrays whose buffer type the type-checker has widened to
 * `ArrayBufferLike` aren't assignable. Copy into a fresh, plain-ArrayBuffer-
 * backed Float32Array to satisfy the signature without a type assertion.
 */
function toArrayBufferBacked(input: Float32Array): Float32Array<ArrayBuffer> {
  const out = new Float32Array(input.length);
  out.set(input);
  return out;
}

async function mixToOffline(args: {
  sceneBuffers: Array<AudioBuffer | null>;
  sceneOffsetsSeconds: number[];
  totalDurationSeconds: number;
  musicBuffer: AudioBuffer | null;
}): Promise<AudioBuffer> {
  const {
    sceneBuffers,
    sceneOffsetsSeconds,
    totalDurationSeconds,
    musicBuffer,
  } = args;

  const length = Math.max(
    1,
    Math.ceil(totalDurationSeconds * TARGET_SAMPLE_RATE)
  );
  const offline = new OfflineAudioContext({
    numberOfChannels: TARGET_CHANNELS,
    length,
    sampleRate: TARGET_SAMPLE_RATE,
  });

  for (let i = 0; i < sceneBuffers.length; i++) {
    const buffer = sceneBuffers[i];
    if (!buffer) continue;
    const src = offline.createBufferSource();
    src.buffer = buffer;
    src.connect(offline.destination);
    src.start(sceneOffsetsSeconds[i]);
  }

  if (musicBuffer) {
    const src = offline.createBufferSource();
    src.buffer = musicBuffer;
    src.connect(offline.destination);
    src.start(0);
  }

  return await offline.startRendering();
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

  // AAC encoders typically prefer 1024-sample frames; we feed in chunks of
  // that size so timestamps line up cleanly.
  const chunkFrames = 1024;
  const totalChunks = Math.ceil(totalFrames / chunkFrames);

  const channelData: Float32Array[] = [];
  for (let c = 0; c < numberOfChannels; c++) {
    channelData.push(mixed.getChannelData(c));
  }

  let firstPacketEmitted = false;
  const pendingAdds: Promise<void>[] = [];
  // See `decodeSceneAudio` — WebCodecs error callbacks fire async and a `throw`
  // there does not propagate through `flush()`. Capture and rethrow.
  let encoderError: Error | null = null;

  const encoder = new AudioEncoder({
    output: (chunk, meta) => {
      const packet = EncodedPacket.fromEncodedChunk(chunk);
      if (!firstPacketEmitted) {
        firstPacketEmitted = true;
        pendingAdds.push(audioSrc.add(packet, meta));
      } else {
        pendingAdds.push(audioSrc.add(packet));
      }
    },
    error: (e) => {
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
    if (signal?.aborted) throw new Error('Browser merge aborted');
    if (encoderError) throw encoderError;
    const start = chunkIndex * chunkFrames;
    const end = Math.min(start + chunkFrames, totalFrames);
    const frames = end - start;

    const interleaved = new Float32Array(frames * numberOfChannels);
    for (let f = 0; f < frames; f++) {
      for (let c = 0; c < numberOfChannels; c++) {
        interleaved[f * numberOfChannels + c] = channelData[c][start + f];
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
  if (encoderError) throw encoderError;
  await Promise.all(pendingAdds);
  onProgress?.(totalChunks, totalChunks);
}
