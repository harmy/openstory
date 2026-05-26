import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { VideoPlayer } from '@/components/motion/video-player';
import type {
  SequenceMusicVariant,
  SequenceVideoVariant,
} from '@/lib/db/schema';
import type { Sequence } from '@/types/database';
import { Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';

type CommonProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sequence: Sequence;
  onPromote: () => void;
  onDiscard: () => void;
  isPromoting?: boolean;
  isDiscarding?: boolean;
  /** Flat string list of upstream entity changes between snapshot and live inputs. */
  upstreamChanges?: string[];
};

type VideoProps = CommonProps & {
  kind: 'video';
  variant: SequenceVideoVariant;
};

type MusicProps = CommonProps & {
  kind: 'music';
  variant: SequenceMusicVariant;
};

type SequenceVariantCompareDialogProps = VideoProps | MusicProps;

const VideoSidePreview: React.FC<{
  src: string | null | undefined;
  alt: string;
  aspectRatio: Sequence['aspectRatio'];
}> = ({ src, alt, aspectRatio }) => {
  if (!src) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-xs text-muted-foreground">
        No {alt}
      </div>
    );
  }
  return <VideoPlayer src={src} aspectRatio={aspectRatio} />;
};

const AudioSidePreview: React.FC<{
  src: string | null | undefined;
  label: string;
}> = ({ src, label }) => {
  if (!src) {
    return (
      <div className="flex h-10 items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-xs text-muted-foreground">
        No {label}
      </div>
    );
  }
  return (
    // eslint-disable-next-line jsx-a11y/media-has-caption -- Compare-dialog renders user-supplied generated audio without captions.
    <audio
      src={src}
      crossOrigin="anonymous"
      controls
      preload="metadata"
      className="h-10 w-full"
    />
  );
};

type DiffRow = { label: string; live: string; alternate: string };

function buildMusicDiffRows(
  sequence: Sequence,
  variant: SequenceMusicVariant
): DiffRow[] {
  const rows: DiffRow[] = [];
  // We don't track live music duration on the sequence row, so the live side
  // stays unknown rather than guessed.
  const liveDuration = '—';
  if ((sequence.musicPrompt ?? '') !== (variant.prompt ?? '')) {
    rows.push({
      label: 'Prompt',
      live: sequence.musicPrompt ?? '—',
      alternate: variant.prompt ?? '—',
    });
  }
  if ((sequence.musicTags ?? '') !== (variant.tags ?? '')) {
    rows.push({
      label: 'Tags',
      live: sequence.musicTags ?? '—',
      alternate: variant.tags ?? '—',
    });
  }
  if ((sequence.musicModel ?? '') !== variant.model) {
    rows.push({
      label: 'Model',
      live: sequence.musicModel ?? '—',
      alternate: variant.model,
    });
  }
  if (variant.durationSeconds !== null) {
    rows.push({
      label: 'Duration',
      live: liveDuration,
      alternate: `${variant.durationSeconds}s`,
    });
  }
  return rows;
}

export const SequenceVariantCompareDialog: React.FC<
  SequenceVariantCompareDialogProps
> = (props) => {
  const {
    open,
    onOpenChange,
    sequence,
    onPromote,
    onDiscard,
    isPromoting = false,
    isDiscarding = false,
    upstreamChanges,
    kind,
  } = props;
  const busy = isPromoting || isDiscarding;

  const [confirmingPromote, setConfirmingPromote] = useState(false);
  useEffect(() => {
    setConfirmingPromote(false);
  }, [open, props.variant.id]);

  const handlePromoteClick = () => {
    if (confirmingPromote) {
      onPromote();
      setConfirmingPromote(false);
      return;
    }
    setConfirmingPromote(true);
  };

  const label = kind === 'video' ? 'merged video' : 'music track';

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Compare alternate {label}</DialogTitle>
          <DialogDescription>
            An alternate {label} was generated from the inputs you had at the
            time. Compare it against the live version, then promote or discard.
          </DialogDescription>
        </DialogHeader>

        {kind === 'video' ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Live (current inputs)</span>
              <VideoSidePreview
                src={sequence.mergedVideoUrl}
                alt="merged video"
                aspectRatio={sequence.aspectRatio}
              />
            </div>
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">
                Alternate (older inputs)
              </span>
              <VideoSidePreview
                src={props.variant.url}
                alt="merged video"
                aspectRatio={sequence.aspectRatio}
              />
            </div>
          </div>
        ) : (
          <>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">
                  Live (current inputs)
                </span>
                <AudioSidePreview src={sequence.musicUrl} label="music track" />
              </div>
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium">
                  Alternate (older inputs)
                </span>
                <AudioSidePreview src={props.variant.url} label="music track" />
              </div>
            </div>

            {(() => {
              const rows = buildMusicDiffRows(sequence, props.variant);
              if (rows.length === 0) return null;
              return (
                <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3">
                  <span className="text-sm font-medium">What changed</span>
                  <ul className="flex flex-col gap-2 text-sm">
                    {rows.map((row) => (
                      <li
                        key={row.label}
                        className="grid grid-cols-[6rem_1fr_1fr] gap-2"
                      >
                        <span className="font-medium text-muted-foreground">
                          {row.label}
                        </span>
                        <span className="text-muted-foreground line-clamp-2">
                          {row.live}
                        </span>
                        <span className="line-clamp-2">{row.alternate}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              );
            })()}
          </>
        )}

        {upstreamChanges && upstreamChanges.length > 0 && (
          <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3">
            <span className="text-sm font-medium">Upstream changes</span>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {upstreamChanges.map((change) => (
                <li key={change}>• {change}</li>
              ))}
            </ul>
          </div>
        )}

        {confirmingPromote && (
          <div
            className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive"
            role="alert"
            aria-live="polite"
          >
            Promote replaces the current {label}. Click Promote again to
            confirm.
          </div>
        )}

        <DialogFooter className="flex flex-row justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onDiscard}
            disabled={busy}
          >
            {isDiscarding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Discard
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handlePromoteClick}
            disabled={busy}
            variant={confirmingPromote ? 'destructive' : 'default'}
          >
            {isPromoting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {confirmingPromote ? 'Confirm Promote' : 'Promote'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
