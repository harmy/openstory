/**
 * Concatenate H.264 video tracks across N scene MP4s into a single
 * `EncodedVideoPacketSource`, offsetting timestamps by each scene's actual
 * encoded duration.
 *
 * Pure transmux: no pixels are decoded. Assumes consistent SPS/PPS across
 * scenes (same motion model on every frame); throws if codec configs differ
 * in a way that would prevent playback.
 */

import {
  ALL_FORMATS,
  BlobSource,
  EncodedPacket,
  EncodedPacketSink,
  Input,
  type EncodedVideoPacketSource,
} from 'mediabunny';

export type VideoConcatProgress = {
  sceneIndex: number;
  totalScenes: number;
};

export type VideoConcatResult = {
  /** Sum of each scene's video track duration, in seconds. */
  totalDurationSeconds: number;
  /** Per-scene duration measured from the input track. */
  sceneDurationsSeconds: number[];
};

export async function concatVideoTracks(args: {
  sceneBlobs: Blob[];
  videoSrc: EncodedVideoPacketSource;
  onProgress?: (p: VideoConcatProgress) => void;
  signal?: AbortSignal;
}): Promise<VideoConcatResult> {
  const { sceneBlobs, videoSrc, onProgress, signal } = args;

  let runningOffsetSeconds = 0;
  let firstPacketEmitted = false;
  let recordedDecoderConfigDescription: string | null = null;
  const sceneDurationsSeconds: number[] = [];

  for (let sceneIndex = 0; sceneIndex < sceneBlobs.length; sceneIndex++) {
    if (signal?.aborted) throw new Error('Browser merge aborted');

    const blob = sceneBlobs[sceneIndex];
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BlobSource(blob),
    });

    try {
      const videoTrack = await input.getPrimaryVideoTrack();
      if (!videoTrack) {
        throw new Error(`Scene ${sceneIndex} has no video track`);
      }

      const codec = await videoTrack.getCodec();
      if (codec !== 'avc') {
        throw new Error(
          `Scene ${sceneIndex} uses codec "${codec}"; browser merge requires H.264 (avc).`
        );
      }

      const decoderConfig = await videoTrack.getDecoderConfig();
      if (!decoderConfig) {
        throw new Error(`Scene ${sceneIndex} has no usable decoder config`);
      }

      // SPS/PPS are carried in description; if scenes differ here they won't
      // play after concatenation. Compare the bytes of the first scene's
      // description to subsequent scenes.
      const description = decoderConfigDescription(decoderConfig);
      if (recordedDecoderConfigDescription === null) {
        recordedDecoderConfigDescription = description;
      } else if (description !== recordedDecoderConfigDescription) {
        throw new Error(
          `Scene ${sceneIndex} has a different H.264 decoder config than scene 0; cannot transmux without re-encoding.`
        );
      }

      const sceneDurationSeconds = await input.computeDuration([videoTrack]);
      sceneDurationsSeconds.push(sceneDurationSeconds);

      const sink = new EncodedPacketSink(videoTrack);
      let isFirstPacketOfScene = true;

      for await (const packet of sink.packets()) {
        if (signal?.aborted) throw new Error('Browser merge aborted');

        const offsetTimestamp = packet.timestamp + runningOffsetSeconds;
        const offsetPacket = new EncodedPacket(
          packet.data,
          packet.type,
          offsetTimestamp,
          packet.duration,
          undefined,
          packet.byteLength,
          packet.sideData
        );

        if (!firstPacketEmitted) {
          await videoSrc.add(offsetPacket, { decoderConfig });
          firstPacketEmitted = true;
        } else if (isFirstPacketOfScene) {
          // Subsequent scenes still get the meta in case the muxer wants to
          // verify; first-scene config is the one that survives in the moov.
          await videoSrc.add(offsetPacket, { decoderConfig });
        } else {
          await videoSrc.add(offsetPacket);
        }
        isFirstPacketOfScene = false;
      }

      runningOffsetSeconds += sceneDurationSeconds;
    } finally {
      // Input doesn't expose an explicit close in the public API; the
      // BlobSource holds a reference to the Blob and is GC'd when input goes
      // out of scope.
    }

    onProgress?.({
      sceneIndex: sceneIndex + 1,
      totalScenes: sceneBlobs.length,
    });
  }

  return {
    totalDurationSeconds: runningOffsetSeconds,
    sceneDurationsSeconds,
  };
}

/**
 * Stable identity for an AVC decoder config — compares the `description`
 * (SPS/PPS bytes). Two scenes with byte-identical descriptions are guaranteed
 * to share parameter sets and can be concatenated without re-encoding.
 */
function decoderConfigDescription(config: VideoDecoderConfig): string {
  if (!config.description) return '';
  const desc = config.description;
  const view =
    desc instanceof ArrayBuffer
      ? new Uint8Array(desc)
      : ArrayBuffer.isView(desc)
        ? new Uint8Array(desc.buffer, desc.byteOffset, desc.byteLength)
        : new Uint8Array(0);
  let hex = '';
  for (let i = 0; i < view.length; i++) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
}
