/**
 * Live playback engine for a stitched sequence (N scene videos + one music
 * track). Modeled on the Mediabunny media-player example, extended with:
 *
 * - `ConcatenatedVideoSource` for the video iterator (handles cross-scene
 *   continuity + global timestamps).
 * - A separate music `Input` + `AudioBufferSink` mixed through a `GainNode`
 *   whose value is derived from the music variant's measured loudness gain.
 * - Codec gating up front via `prepare()`; throws so the React component can
 *   render a fallback CTA.
 *
 * The engine is intentionally not React-aware: it manipulates an externally-
 * provided `HTMLCanvasElement` and surfaces lifecycle via callbacks. The
 * matching React component lives in `src/components/theatre/sequence-player.tsx`.
 */

import {
  ALL_FORMATS,
  AudioBufferSink,
  Input,
  type InputAudioTrack,
  UrlSource,
  type WrappedAudioBuffer,
  type WrappedCanvas,
} from 'mediabunny';

import {
  ConcatenatedVideoSource,
  type SceneInput,
} from './concatenated-video-source';

export type SequencePlayerOptions = {
  canvas: HTMLCanvasElement;
  scenes: SceneInput[];
  musicUrl: string | null;
  /**
   * Gain in dB to apply to the music track to hit the broadcast loudness
   * target. `null` falls back to 0 dB (no normalization). See
   * `sequence_music_variants.loudness_gain_db`.
   */
  musicLoudnessGainDb: number | null;
  onTimeUpdate?: (time: number) => void;
  onEnded?: () => void;
  onError?: (error: Error) => void;
};

export type SequencePlayerMeta = {
  durationSeconds: number;
  displayWidth: number;
  displayHeight: number;
  hasAudio: boolean;
};

export class SequencePlayerEngine {
  private readonly opts: SequencePlayerOptions;
  private readonly canvasContext: CanvasRenderingContext2D;
  private readonly videoSource: ConcatenatedVideoSource;

  private audioContext: AudioContext | null = null;
  private gainNode: GainNode | null = null;
  private musicInput: Input | null = null;
  private musicTrack: InputAudioTrack | null = null;
  private audioSink: AudioBufferSink | null = null;

  private meta: SequencePlayerMeta | null = null;

  private playing = false;
  private playbackTimeAtStart = 0;
  private audioContextStartTime: number | null = null;

  private videoFrameIterator: AsyncGenerator<
    WrappedCanvas,
    void,
    unknown
  > | null = null;
  private audioBufferIterator: AsyncGenerator<
    WrappedAudioBuffer,
    void,
    unknown
  > | null = null;
  private nextFrame: WrappedCanvas | null = null;
  private readonly queuedAudioNodes = new Set<AudioBufferSourceNode>();

  private asyncId = 0;
  private rafHandle = -1;
  private disposed = false;
  private volume = 1;
  private muted = false;

  constructor(opts: SequencePlayerOptions) {
    const ctx = opts.canvas.getContext('2d');
    if (!ctx) {
      throw new Error('SequencePlayerEngine: 2d canvas context unavailable');
    }
    this.opts = opts;
    this.canvasContext = ctx;
    this.videoSource = new ConcatenatedVideoSource(opts.scenes);
  }

  /**
   * Open every scene's video + the music track, probe decodability, and size
   * the canvas. Must be called once before `play()` / `seek()`.
   *
   * Throws on undecodable codec — the React component should catch and render
   * an "Export to download" fallback CTA.
   */
  async prepare(): Promise<SequencePlayerMeta> {
    const videoMeta = await this.videoSource.prepare();

    let musicSampleRate: number | undefined;
    let hasAudio = false;
    if (this.opts.musicUrl) {
      // Cache-buster avoids the Cloudflare-edge CORS issue documented in
      // ConcatenatedVideoSource — the music URL is also rendered as
      // `<audio src>` elsewhere, so the edge has it cached without
      // `Vary: Origin` and a bare fetch() with an Origin header is blocked.
      const sep = this.opts.musicUrl.includes('?') ? '&' : '?';
      const musicUrl = `${this.opts.musicUrl}${sep}_sp=1`;
      this.musicInput = new Input({
        formats: ALL_FORMATS,
        source: new UrlSource(musicUrl),
      });
      this.musicTrack = await this.musicInput.getPrimaryAudioTrack();
      if (this.musicTrack && (await this.musicTrack.canDecode())) {
        musicSampleRate = await this.musicTrack.getSampleRate();
        hasAudio = true;
      } else {
        this.musicTrack = null;
        this.musicInput.dispose();
        this.musicInput = null;
      }
    }

    // WebCodecs (already gated above via canDecode()) is only available on
    // browsers that ship the standard, unprefixed AudioContext, so we can use
    // it directly without a webkit fallback.
    this.audioContext = new AudioContext({ sampleRate: musicSampleRate });
    this.gainNode = this.audioContext.createGain();
    this.gainNode.connect(this.audioContext.destination);
    this.applyGain();

    if (this.musicTrack) {
      this.audioSink = new AudioBufferSink(this.musicTrack);
    }

    this.opts.canvas.width = videoMeta.displayWidth;
    this.opts.canvas.height = videoMeta.displayHeight;

    this.meta = {
      durationSeconds: videoMeta.totalDurationSeconds,
      displayWidth: videoMeta.displayWidth,
      displayHeight: videoMeta.displayHeight,
      hasAudio,
    };

    await this.primeFirstFrame();
    this.startRenderLoop();

    return this.meta;
  }

  getMeta(): SequencePlayerMeta {
    if (!this.meta) {
      throw new Error('SequencePlayerEngine: prepare() must be called first');
    }
    return this.meta;
  }

  getPlaybackTime(): number {
    if (
      this.playing &&
      this.audioContext &&
      this.audioContextStartTime !== null
    ) {
      return (
        this.audioContext.currentTime -
        this.audioContextStartTime +
        this.playbackTimeAtStart
      );
    }
    return this.playbackTimeAtStart;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  async play(): Promise<void> {
    if (this.playing || !this.audioContext || !this.meta) return;

    if (this.audioContext.state === 'suspended') {
      await this.audioContext.resume();
    }

    if (this.playbackTimeAtStart >= this.meta.durationSeconds) {
      // Snap back to the start if we ran off the end
      this.playbackTimeAtStart = 0;
      await this.restartVideoIterator();
    }

    this.audioContextStartTime = this.audioContext.currentTime;
    this.playing = true;

    if (this.audioSink) {
      void this.audioBufferIterator?.return();
      this.audioBufferIterator = this.audioSink.buffers(this.getPlaybackTime());
      void this.runAudioIterator();
    }
  }

  pause(): void {
    if (!this.playing) return;
    this.playbackTimeAtStart = this.getPlaybackTime();
    this.playing = false;
    void this.audioBufferIterator?.return();
    this.audioBufferIterator = null;
    for (const node of this.queuedAudioNodes) {
      try {
        node.stop();
      } catch {
        // Already stopped; ignore.
      }
    }
    this.queuedAudioNodes.clear();
  }

  async seek(seconds: number): Promise<void> {
    if (!this.meta) return;
    const wasPlaying = this.playing;
    if (wasPlaying) this.pause();

    this.playbackTimeAtStart = Math.max(
      0,
      Math.min(seconds, this.meta.durationSeconds)
    );
    this.opts.onTimeUpdate?.(this.playbackTimeAtStart);

    await this.restartVideoIterator();

    if (wasPlaying && this.playbackTimeAtStart < this.meta.durationSeconds) {
      void this.play();
    }
  }

  setVolume(volume: number): void {
    this.volume = Math.max(0, Math.min(1, volume));
    this.applyGain();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyGain();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    cancelAnimationFrame(this.rafHandle);
    void this.videoFrameIterator?.return();
    this.videoFrameIterator = null;
    this.videoSource.dispose();
    if (this.musicInput) {
      this.musicInput.dispose();
      this.musicInput = null;
    }
    void this.audioContext?.close();
    this.audioContext = null;
    this.audioSink = null;
    this.gainNode = null;
  }

  private applyGain(): void {
    if (!this.gainNode) return;
    const linear = this.muted ? 0 : this.volume ** 2;
    const loudnessLinear = loudnessDbToLinear(this.opts.musicLoudnessGainDb);
    this.gainNode.gain.value = linear * loudnessLinear;
  }

  private async primeFirstFrame(): Promise<void> {
    this.asyncId++;
    await this.videoFrameIterator?.return();
    this.videoFrameIterator = this.videoSource.canvases(
      this.playbackTimeAtStart,
      { poolSize: 2, fit: 'contain' }
    );
    const first = (await this.videoFrameIterator.next()).value ?? null;
    const second = (await this.videoFrameIterator.next()).value ?? null;
    this.nextFrame = second;
    if (first) {
      this.drawFrame(first);
    }
  }

  private async restartVideoIterator(): Promise<void> {
    await this.primeFirstFrame();
  }

  private startRenderLoop(): void {
    const tick = () => {
      if (this.disposed) return;
      if (this.meta) {
        const playbackTime = this.getPlaybackTime();
        if (this.playing && playbackTime >= this.meta.durationSeconds) {
          this.endPlayback();
        }
        if (this.nextFrame && this.nextFrame.timestamp <= playbackTime) {
          this.drawFrame(this.nextFrame);
          this.nextFrame = null;
          void this.advanceFrame();
        }
        if (this.playing) {
          this.opts.onTimeUpdate?.(playbackTime);
        }
      }
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private drawFrame(frame: WrappedCanvas): void {
    const { width, height } = this.opts.canvas;
    this.canvasContext.clearRect(0, 0, width, height);
    this.canvasContext.drawImage(frame.canvas, 0, 0);
  }

  private async advanceFrame(): Promise<void> {
    const currentAsyncId = this.asyncId;
    let iterator = this.videoFrameIterator;
    while (iterator) {
      const newNextFrame = (await iterator.next()).value ?? null;
      if (currentAsyncId !== this.asyncId) return;
      if (!newNextFrame) {
        // Iterator naturally exhausted — treat that as end-of-sequence so we
        // don't sit on a frozen last frame waiting for the clock to catch up
        // to a possibly-overreported total duration.
        if (this.playing) this.endPlayback();
        return;
      }
      const playbackTime = this.getPlaybackTime();
      if (newNextFrame.timestamp <= playbackTime) {
        // Already late — draw and keep searching for a future frame.
        this.drawFrame(newNextFrame);
        iterator = this.videoFrameIterator;
        continue;
      }
      this.nextFrame = newNextFrame;
      return;
    }
  }

  private endPlayback(): void {
    if (!this.meta) return;
    this.pause();
    this.playbackTimeAtStart = this.meta.durationSeconds;
    this.opts.onTimeUpdate?.(this.meta.durationSeconds);
    this.opts.onEnded?.();
  }

  /**
   * Schedule decoded music buffers against the AudioContext clock. Mirrors
   * the mediabunny media-player example's loop, with the gain stage providing
   * loudness normalization.
   */
  private async runAudioIterator(): Promise<void> {
    if (!this.audioBufferIterator || !this.audioContext || !this.gainNode) {
      return;
    }
    for await (const { buffer, timestamp } of this.audioBufferIterator) {
      if (this.disposed) return;
      const startBaseline = this.audioContextStartTime;
      if (startBaseline === null) return;
      const node = this.audioContext.createBufferSource();
      node.buffer = buffer;
      node.connect(this.gainNode);

      let startTimestamp = startBaseline + timestamp - this.playbackTimeAtStart;
      startTimestamp =
        Math.round(this.audioContext.sampleRate * startTimestamp) /
        this.audioContext.sampleRate;

      if (startTimestamp >= this.audioContext.currentTime) {
        node.start(startTimestamp);
      } else {
        node.start(
          this.audioContext.currentTime,
          this.audioContext.currentTime - startTimestamp
        );
      }

      this.queuedAudioNodes.add(node);
      node.onended = () => {
        this.queuedAudioNodes.delete(node);
      };

      // Throttle: don't get more than ~1s ahead of playback.
      if (timestamp - this.getPlaybackTime() >= 1) {
        await new Promise<void>((resolve) => {
          const id = window.setInterval(() => {
            if (this.disposed || timestamp - this.getPlaybackTime() < 1) {
              clearInterval(id);
              resolve();
            }
          }, 100);
        });
      }
    }
  }
}

function loudnessDbToLinear(loudnessGainDb: number | null): number {
  if (loudnessGainDb === null || !Number.isFinite(loudnessGainDb)) return 1;
  return Math.pow(10, loudnessGainDb / 20);
}
