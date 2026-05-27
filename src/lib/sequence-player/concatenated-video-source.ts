/**
 * A "logical" Mediabunny video source that stitches N scene MP4s into a single
 * canvas/packet stream with monotonically-increasing global timestamps.
 *
 * Used by:
 * - The live `<SequencePlayer>` — `canvases(globalTime)` yields `WrappedCanvas`
 *   frames whose timestamp is offset by each scene's cumulative start, so the
 *   player's `AudioContext`-clock-driven render loop can compare against a
 *   single timeline.
 * - The export pipeline — `packets(globalTime)` yields `EncodedPacket`s whose
 *   timestamps are offset the same way, ready to feed into an
 *   `EncodedVideoPacketSource` for transmux into a single MP4.
 *
 * Scene durations and display dimensions are precomputed in `prepare()` so that
 * `seek(globalTime)` is O(log N) and the player can build a progress bar before
 * playback begins.
 */

import {
  ALL_FORMATS,
  CanvasSink,
  EncodedPacket,
  EncodedPacketSink,
  Input,
  type InputVideoTrack,
  UrlSource,
  type WrappedCanvas,
} from 'mediabunny';
import { addCorsCacheBuster } from '@/lib/utils/cors-cache-buster';

type CanvasFit = 'fill' | 'contain' | 'cover';

export type SceneInput = {
  orderIndex: number;
  videoUrl: string;
};

export type SceneSlice = {
  /** Index into the (sorted) scenes array. */
  sceneIndex: number;
  /** Time within that scene, in seconds. */
  localTime: number;
};

export type ConcatenatedVideoMeta = {
  /** Total stitched duration in seconds. */
  totalDurationSeconds: number;
  /** Per-scene duration (seconds), in order. */
  sceneDurationsSeconds: number[];
  /** Cumulative scene start offsets (seconds), in order. */
  sceneOffsetsSeconds: number[];
  /** Display dimensions of the first scene — assumed consistent across scenes. */
  displayWidth: number;
  displayHeight: number;
};

export class ConcatenatedVideoSource {
  private readonly scenes: SceneInput[];
  private inputs: Input[] = [];
  private videoTracks: InputVideoTrack[] = [];
  private meta: ConcatenatedVideoMeta | null = null;

  constructor(scenes: SceneInput[]) {
    if (scenes.length === 0) {
      throw new Error(
        'ConcatenatedVideoSource: at least one scene is required'
      );
    }
    this.scenes = [...scenes].sort((a, b) => a.orderIndex - b.orderIndex);
  }

  /**
   * Open every scene's `Input`, probe duration + display dimensions, and build
   * the cumulative offset table. Must be called once before any iterator.
   */
  async prepare(): Promise<ConcatenatedVideoMeta> {
    if (this.meta) return this.meta;

    const inputs: Input[] = [];
    const videoTracks: InputVideoTrack[] = [];
    const sceneDurationsSeconds: number[] = [];
    let displayWidth = 0;
    let displayHeight = 0;

    for (let i = 0; i < this.scenes.length; i++) {
      const scene = this.scenes[i];
      if (!scene) continue;
      const input = new Input({
        formats: ALL_FORMATS,
        source: new UrlSource(addCorsCacheBuster(scene.videoUrl)),
      });
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) {
        throw new Error(`Scene ${i} has no video track`);
      }
      if (!(await videoTrack.canDecode())) {
        throw new Error(`Scene ${i} cannot be decoded by this browser`);
      }
      // Prefer container metadata — it's cheap and matches the player's
      // perceived end. `computeDuration()` scans every packet and on Kling /
      // ffmpeg-generated MP4s can over-report by ~2× when the timebase or
      // edit-list isn't what it expects (#742).
      const metaDuration = await input.getDurationFromMetadata([videoTrack], {
        skipLiveWait: true,
      });
      const duration =
        metaDuration ??
        (await input.computeDuration([videoTrack], { skipLiveWait: true }));

      if (i === 0) {
        displayWidth = await videoTrack.getDisplayWidth();
        displayHeight = await videoTrack.getDisplayHeight();
      }

      inputs.push(input);
      videoTracks.push(videoTrack);
      sceneDurationsSeconds.push(duration);
    }

    const sceneOffsetsSeconds: number[] = [];
    let acc = 0;
    for (const d of sceneDurationsSeconds) {
      sceneOffsetsSeconds.push(acc);
      acc += d;
    }

    this.inputs = inputs;
    this.videoTracks = videoTracks;
    this.meta = {
      totalDurationSeconds: acc,
      sceneDurationsSeconds,
      sceneOffsetsSeconds,
      displayWidth,
      displayHeight,
    };
    return this.meta;
  }

  getMeta(): ConcatenatedVideoMeta {
    if (!this.meta) {
      throw new Error(
        'ConcatenatedVideoSource: prepare() must be called first'
      );
    }
    return this.meta;
  }

  /**
   * Map a global timeline time to a specific scene + local time. Clamps to the
   * last scene's end when `globalTime >= totalDuration`.
   */
  locate(globalTime: number): SceneSlice {
    const meta = this.getMeta();
    const time = Math.max(0, globalTime);
    for (let i = meta.sceneOffsetsSeconds.length - 1; i >= 0; i--) {
      const offset = meta.sceneOffsetsSeconds[i];
      if (offset === undefined) continue;
      if (time >= offset) {
        return { sceneIndex: i, localTime: time - offset };
      }
    }
    return { sceneIndex: 0, localTime: 0 };
  }

  /**
   * Live-playback iterator: yields `WrappedCanvas` frames starting at
   * `globalTime`, transparently rolling over from scene N to scene N+1 with
   * the timestamp re-anchored to the global timeline.
   *
   * Honors `signal` for cancellation between scenes and between frames.
   */
  async *canvases(
    globalTime: number,
    options: {
      poolSize?: number;
      fit?: CanvasFit;
      signal?: AbortSignal;
    } = {}
  ): AsyncGenerator<WrappedCanvas, void, unknown> {
    const { poolSize = 2, fit = 'contain', signal } = options;
    const meta = this.getMeta();
    const { sceneIndex: startSceneIndex, localTime: startLocalTime } =
      this.locate(globalTime);

    for (
      let sceneIndex = startSceneIndex;
      sceneIndex < this.videoTracks.length;
      sceneIndex++
    ) {
      if (signal?.aborted) return;

      const videoTrack = this.videoTracks[sceneIndex];
      const offset = meta.sceneOffsetsSeconds[sceneIndex];
      if (!videoTrack || offset === undefined) continue;
      const sink = new CanvasSink(videoTrack, { poolSize, fit });
      const localStart = sceneIndex === startSceneIndex ? startLocalTime : 0;

      const iterator = sink.canvases(localStart);
      try {
        for await (const frame of iterator) {
          if (signal?.aborted) return;
          yield {
            ...frame,
            timestamp: frame.timestamp + offset,
            duration: frame.duration,
          };
        }
      } finally {
        await iterator.return();
      }
    }
  }

  /**
   * Export iterator: yields raw `EncodedPacket`s with offset timestamps,
   * suitable for feeding to `EncodedVideoPacketSource.add()` in the export
   * pipeline. Verifies that scenes share a byte-identical AVC decoder config
   * so transmux is safe.
   */
  async *packets(
    options: { signal?: AbortSignal } = {}
  ): AsyncGenerator<
    { packet: EncodedPacket; decoderConfig: VideoDecoderConfig | null },
    void,
    unknown
  > {
    const { signal } = options;
    const meta = this.getMeta();

    let recordedDescriptionHex: string | null = null;
    let firstPacketEmitted = false;

    for (
      let sceneIndex = 0;
      sceneIndex < this.videoTracks.length;
      sceneIndex++
    ) {
      if (signal?.aborted) return;

      const videoTrack = this.videoTracks[sceneIndex];
      const offset = meta.sceneOffsetsSeconds[sceneIndex];
      if (!videoTrack || offset === undefined) continue;

      const codec = await videoTrack.getCodec();
      if (codec !== 'avc') {
        throw new Error(
          `Scene ${sceneIndex} uses codec "${codec}"; export requires H.264 (avc).`
        );
      }
      const decoderConfig = await videoTrack.getDecoderConfig();
      if (!decoderConfig) {
        throw new Error(`Scene ${sceneIndex} has no usable decoder config`);
      }

      const description = decoderConfigDescriptionHex(decoderConfig);
      if (description.length === 0) {
        throw new Error(
          `Scene ${sceneIndex} has no SPS/PPS in its decoder config; cannot concatenate.`
        );
      }
      if (recordedDescriptionHex === null) {
        recordedDescriptionHex = description;
      } else if (description !== recordedDescriptionHex) {
        throw new Error(
          `Scene ${sceneIndex} has a different H.264 decoder config than scene 0; cannot transmux without re-encoding.`
        );
      }

      const sink = new EncodedPacketSink(videoTrack);
      for await (const packet of sink.packets()) {
        if (signal?.aborted) return;
        const offsetTimestamp = packet.timestamp + offset;
        const offsetPacket = new EncodedPacket(
          packet.data,
          packet.type,
          offsetTimestamp,
          packet.duration,
          undefined,
          packet.byteLength,
          packet.sideData
        );
        yield {
          packet: offsetPacket,
          decoderConfig: firstPacketEmitted ? null : decoderConfig,
        };
        firstPacketEmitted = true;
      }
    }
  }

  /** Release every underlying `Input` — call when the source is no longer needed. */
  dispose(): void {
    for (const input of this.inputs) input.dispose();
    this.inputs = [];
    this.videoTracks = [];
    this.meta = null;
  }
}

function decoderConfigDescriptionHex(config: VideoDecoderConfig): string {
  const desc = config.description;
  if (!desc) return '';
  const view =
    desc instanceof ArrayBuffer
      ? new Uint8Array(desc)
      : ArrayBuffer.isView(desc)
        ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
        : null;
  if (!view || view.length === 0) return '';
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += (view[i] ?? 0).toString(16).padStart(2, '0');
  }
  return hex;
}
