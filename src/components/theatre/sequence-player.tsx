/**
 * Live in-browser theatre player. Stitches scene videos + a single music track
 * via Mediabunny, without ever producing a merged-MP4 artifact server-side.
 *
 * Falls back to a CTA ("Export as MP4 to download") when the browser can't
 * decode the source codecs — this is the only path to a fallback. The export
 * pipeline lives in `src/lib/sequence-player/export.ts`.
 */

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  getAspectRatioClassName,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import {
  SequencePlayerEngine,
  type SequencePlayerMeta,
} from '@/lib/sequence-player/playback';
import type { SceneInput } from '@/lib/sequence-player/concatenated-video-source';
import { cn } from '@/lib/utils';
import { AlertCircle, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

type SequencePlayerProps = {
  scenes: SceneInput[];
  musicUrl: string | null;
  musicLoudnessGainDb: number | null;
  aspectRatio: AspectRatio;
  className?: string;
  /** Slot rendered as an overlay (top-right) — e.g. the Share dropdown. */
  overlayActions?: React.ReactNode;
};

export const SequencePlayer: React.FC<SequencePlayerProps> = ({
  scenes,
  musicUrl,
  musicLoudnessGainDb,
  aspectRatio,
  className,
  overlayActions,
}) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const engineRef = useRef<SequencePlayerEngine | null>(null);

  const [meta, setMeta] = useState<SequencePlayerMeta | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [volume, setVolume] = useState(0.7);
  const [muted, setMuted] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (scenes.length === 0) {
      setError('No scenes ready to play yet.');
      return;
    }

    let cancelled = false;
    const engine = new SequencePlayerEngine({
      canvas,
      scenes,
      musicUrl,
      musicLoudnessGainDb,
      onTimeUpdate: (t) => {
        if (!cancelled) setCurrentTime(t);
      },
      onEnded: () => {
        if (!cancelled) setPlaying(false);
      },
      onError: (err) => {
        if (!cancelled) setError(err.message);
      },
    });
    engineRef.current = engine;

    engine
      .prepare()
      .then((m) => {
        if (cancelled) return;
        setMeta(m);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load video');
      });

    return () => {
      cancelled = true;
      engine.dispose();
      engineRef.current = null;
    };
    // The scene list/music identity drives the engine lifecycle; volume/muted
    // are pushed through setters below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenes, musicUrl, musicLoudnessGainDb]);

  useEffect(() => {
    engineRef.current?.setVolume(volume);
  }, [volume]);

  useEffect(() => {
    engineRef.current?.setMuted(muted);
  }, [muted]);

  const togglePlay = () => {
    const engine = engineRef.current;
    if (!engine) return;
    if (engine.isPlaying()) {
      engine.pause();
      setPlaying(false);
    } else {
      void engine.play().then(() => setPlaying(true));
    }
  };

  const seek = (seconds: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    void engine.seek(seconds);
  };

  if (error) {
    return (
      <div
        data-testid="player-error"
        className={cn(
          'flex flex-col items-center justify-center gap-3 rounded-lg border bg-muted/20 p-8',
          className,
          getAspectRatioClassName(aspectRatio)
        )}
      >
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-sm text-muted-foreground text-center">{error}</p>
        <p className="text-xs text-muted-foreground text-center max-w-sm">
          Export your sequence to download an MP4 you can play in any browser.
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="sequence-player"
      data-state={meta ? 'ready' : 'loading'}
      className={cn(
        'relative w-full overflow-hidden rounded-lg bg-black',
        className,
        getAspectRatioClassName(aspectRatio)
      )}
    >
      <canvas
        ref={canvasRef}
        className="absolute inset-0 h-full w-full object-contain"
        aria-label="Sequence playback"
      />
      {!meta && (
        <Skeleton
          data-testid="player-loading"
          className="absolute inset-0 h-full w-full bg-muted/40"
        />
      )}
      {overlayActions && (
        <div className="absolute top-2 right-2 z-10">{overlayActions}</div>
      )}
      {meta && (
        <PlayerControls
          playing={playing}
          currentTime={currentTime}
          duration={meta.durationSeconds}
          volume={volume}
          muted={muted || !meta.hasAudio}
          hasAudio={meta.hasAudio}
          onTogglePlay={togglePlay}
          onSeek={seek}
          onVolumeChange={setVolume}
          onToggleMute={() => setMuted((m) => !m)}
        />
      )}
    </div>
  );
};

type PlayerControlsProps = {
  playing: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  muted: boolean;
  hasAudio: boolean;
  onTogglePlay: () => void;
  onSeek: (seconds: number) => void;
  onVolumeChange: (v: number) => void;
  onToggleMute: () => void;
};

const PlayerControls: React.FC<PlayerControlsProps> = ({
  playing,
  currentTime,
  duration,
  volume,
  muted,
  hasAudio,
  onTogglePlay,
  onSeek,
  onVolumeChange,
  onToggleMute,
}) => {
  const progress = duration > 0 ? (currentTime / duration) * 100 : 0;

  return (
    <div className="absolute inset-x-0 bottom-0 flex flex-col gap-2 bg-gradient-to-t from-black/80 to-transparent p-3">
      <button
        type="button"
        aria-label="Seek"
        className="group relative h-2 cursor-pointer rounded-full bg-white/20"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const fraction = (e.clientX - rect.left) / rect.width;
          onSeek(fraction * duration);
        }}
      >
        <div
          className="h-full rounded-full bg-white transition-[width] duration-75"
          style={{ width: `${progress}%` }}
        />
      </button>
      <div className="flex items-center gap-3 text-white">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-white hover:bg-white/10 hover:text-white"
          onClick={onTogglePlay}
          aria-label={playing ? 'Pause' : 'Play'}
        >
          {playing ? (
            <Pause className="h-4 w-4" />
          ) : (
            <Play className="h-4 w-4" />
          )}
        </Button>
        <span className="text-xs tabular-nums">
          {formatTimestamp(currentTime)} / {formatTimestamp(duration)}
        </span>
        <div className="flex-1" />
        {hasAudio && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-white hover:bg-white/10 hover:text-white"
              onClick={onToggleMute}
              aria-label={muted ? 'Unmute' : 'Mute'}
            >
              {muted ? (
                <VolumeX className="h-4 w-4" />
              ) : (
                <Volume2 className="h-4 w-4" />
              )}
            </Button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={muted ? 0 : volume}
              onChange={(e) => onVolumeChange(Number(e.target.value))}
              className="h-1 w-20 accent-white"
              aria-label="Volume"
            />
          </div>
        )}
      </div>
    </div>
  );
};

function formatTimestamp(seconds: number): string {
  const safe = Math.max(0, Math.round(seconds));
  const minutes = Math.floor(safe / 60);
  const secs = safe % 60;
  return `${minutes}:${secs.toString().padStart(2, '0')}`;
}
