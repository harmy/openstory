/**
 * WebCodecs capability probe.
 *
 * The browser merge requires:
 * - `VideoDecoder` for verifying we can read incoming H.264 streams
 *   (we transmux without re-encoding video, but we still verify decodability
 *   to fail early on broken inputs).
 * - `AudioEncoder` for AAC (we decode native + music PCM, mix, re-encode).
 *
 * If either is missing or the platform reports `avc1.640028` / `mp4a.40.2`
 * unsupported, we throw `BrowserMergeUnsupportedError` so the caller can
 * surface a clear toast to the user.
 */

const REQUIRED_VIDEO_CODEC = 'avc1.640028' as const; // H.264 High @ L4.0
const REQUIRED_AUDIO_CODEC = 'mp4a.40.2' as const; // AAC-LC

export class BrowserMergeUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserMergeUnsupportedError';
  }
}

export async function probeBrowserMergeCapabilities(): Promise<void> {
  if (typeof window === 'undefined') {
    throw new BrowserMergeUnsupportedError(
      'Browser merge requires a browser environment.'
    );
  }

  if (typeof globalThis.VideoDecoder === 'undefined') {
    throw new BrowserMergeUnsupportedError(
      'Your browser does not support WebCodecs VideoDecoder. Please use Chrome, Edge, Safari 16.4+, or Firefox 130+.'
    );
  }

  if (typeof globalThis.AudioEncoder === 'undefined') {
    throw new BrowserMergeUnsupportedError(
      'Your browser does not support WebCodecs AudioEncoder. Please use Chrome, Edge, Safari 16.4+, or Firefox 130+.'
    );
  }

  const [videoSupport, audioSupport] = await Promise.all([
    VideoDecoder.isConfigSupported({
      codec: REQUIRED_VIDEO_CODEC,
      codedWidth: 1920,
      codedHeight: 1080,
    }),
    AudioEncoder.isConfigSupported({
      codec: REQUIRED_AUDIO_CODEC,
      sampleRate: 48000,
      numberOfChannels: 2,
      bitrate: 192_000,
    }),
  ]);

  if (!videoSupport.supported) {
    throw new BrowserMergeUnsupportedError(
      `Your browser cannot decode H.264 video (${REQUIRED_VIDEO_CODEC}).`
    );
  }

  if (!audioSupport.supported) {
    throw new BrowserMergeUnsupportedError(
      `Your browser cannot encode AAC audio (${REQUIRED_AUDIO_CODEC}).`
    );
  }
}
