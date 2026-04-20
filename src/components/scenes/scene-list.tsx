import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { Frame } from '@/types/database';
import { Loader2, Video } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { SceneListItem } from './scene-list-item';

type SceneListProps = {
  frames?: Frame[] | undefined;
  selectedFrameId?: string;
  aspectRatio: AspectRatio;
  onSelectFrame: (frameId: string) => void;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  onBatchGenerateMotion?: (includeMusic: boolean) => Promise<void>;
  musicPromptsReady: boolean;
  /** Hide the batch motion button (e.g. while auto-generate motion is in flight). */
  hideBatchButton?: boolean;
};

const isCompleted = (frame: Frame) => {
  const isFullyGenerated =
    frame.thumbnailStatus === 'completed' && frame.videoStatus === 'completed';
  return isFullyGenerated;
};

const SceneListComponent: React.FC<SceneListProps> = ({
  frames,
  selectedFrameId,
  aspectRatio,
  onSelectFrame,
  regeneratingImages,
  regeneratingMotion,
  onBatchGenerateMotion,
  musicPromptsReady,
  hideBatchButton = false,
}) => {
  const [isGenerating, setIsGenerating] = useState(false);
  const [includeMusic, setIncludeMusic] = useState(true);

  const totalFrames = frames?.length ?? 0;

  // Frames that need to be kicked off (not already generating)
  const notStartedFrames = useMemo(() => {
    if (!frames) return [];
    return frames.filter(
      (f) =>
        (f.videoStatus === 'pending' || f.videoStatus === 'failed') &&
        f.thumbnailStatus === 'completed'
    );
  }, [frames]);

  const hasGeneratingFrames = useMemo(() => {
    if (!frames) return false;
    return frames.some(
      (f) => f.videoStatus === 'generating' && f.thumbnailStatus === 'completed'
    );
  }, [frames]);

  // Check if all eligible frames have motion prompts ready
  const motionPromptsReady = useMemo(() => {
    if (!notStartedFrames.length) return true;
    return notStartedFrames.every(
      (f) => f.motionPrompt || f.metadata?.prompts?.motion?.fullPrompt
    );
  }, [notStartedFrames]);

  const handleGenerateMotion = async () => {
    if (!onBatchGenerateMotion || notStartedFrames.length === 0) return;

    setIsGenerating(true);
    try {
      await onBatchGenerateMotion(includeMusic);
    } finally {
      setIsGenerating(false);
    }
  };

  const isMotionInProgress = regeneratingMotion.size > 0 || hasGeneratingFrames;
  const showButton =
    !hideBatchButton && (notStartedFrames.length > 0 || isMotionInProgress);
  const isButtonDisabled =
    isGenerating ||
    notStartedFrames.length === 0 ||
    !motionPromptsReady ||
    (includeMusic && !musicPromptsReady);

  return (
    <div className="flex h-full w-[280px] lg:w-[480px] flex-col rounded-lg border bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-b px-4 py-3">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          Scenes
        </h2>
      </div>

      {/* Scene list */}
      <ScrollArea className="flex-1 min-h-0">
        <div className="flex flex-col gap-3 p-4">
          {(frames === undefined || frames.length === 0) &&
            [1, 2, 3].map((i) => (
              <SceneListItem
                key={`frame-skeleton-${i}`}
                frame={undefined}
                aspectRatio={aspectRatio}
                isActive={false}
                isCompleted={false}
                onSelect={function (): void {
                  throw new Error('Function not implemented.');
                }}
              />
            ))}

          {frames &&
            frames.map((frame) => (
              <SceneListItem
                key={frame.id}
                frame={frame}
                aspectRatio={aspectRatio}
                isActive={frame.id === selectedFrameId}
                isCompleted={isCompleted(frame)}
                onSelect={() => onSelectFrame(frame.id)}
                isRegeneratingImage={regeneratingImages.has(frame.id)}
                isRegeneratingMotion={regeneratingMotion.has(frame.id)}
              />
            ))}
        </div>
      </ScrollArea>

      {/* Sticky footer with Generate Motion button */}
      {showButton && (
        <div className="sticky bottom-0 border-t bg-background p-4 flex flex-col gap-3">
          <Button
            variant="default"
            className="w-full"
            onClick={() => void handleGenerateMotion()}
            disabled={isButtonDisabled}
          >
            {isGenerating ||
            (notStartedFrames.length === 0 && isMotionInProgress) ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Generating…
              </>
            ) : !motionPromptsReady ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Writing motion prompts…
              </>
            ) : includeMusic && !musicPromptsReady ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Composing music…
              </>
            ) : (
              <>
                <Video className="mr-2 h-4 w-4" />
                Generate {notStartedFrames.length} / {totalFrames}{' '}
                {totalFrames === 1 ? 'frame' : 'frames'}
              </>
            )}
          </Button>
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <Checkbox
              checked={includeMusic}
              onCheckedChange={(checked) => setIncludeMusic(checked === true)}
              disabled={!musicPromptsReady}
            />
            <span>
              Also generate music
              {!musicPromptsReady && (
                <span className="text-xs ml-1">(preparing…)</span>
              )}
            </span>
          </label>
        </div>
      )}
    </div>
  );
};

// Custom equality check to prevent unnecessary re-renders during polling
// Relies on TanStack Query's structural sharing to preserve frame object references
const areEqual = (
  prevProps: SceneListProps,
  nextProps: SceneListProps
): boolean => {
  // Compare primitive props
  if (
    prevProps.selectedFrameId !== nextProps.selectedFrameId ||
    prevProps.aspectRatio !== nextProps.aspectRatio ||
    prevProps.musicPromptsReady !== nextProps.musicPromptsReady
  ) {
    return false;
  }

  // Compare regenerating Sets by reference (parent creates new Set on change)
  if (
    prevProps.regeneratingImages !== nextProps.regeneratingImages ||
    prevProps.regeneratingMotion !== nextProps.regeneratingMotion
  ) {
    return false;
  }

  // Compare callback references
  if (prevProps.onBatchGenerateMotion !== nextProps.onBatchGenerateMotion) {
    return false;
  }

  // Compare frames array
  // TanStack Query's structural sharing should maintain the same array reference
  // if the content hasn't changed, so reference equality check is sufficient
  if (prevProps.frames === nextProps.frames) {
    return true;
  }

  // If one is undefined and the other isn't, they're not equal
  if (!prevProps.frames || !nextProps.frames) {
    return false;
  }

  // If array lengths differ, they're not equal
  if (prevProps.frames.length !== nextProps.frames.length) {
    return false;
  }

  // Check if frame object references have changed (structural sharing preserves refs)
  for (let i = 0; i < prevProps.frames.length; i++) {
    if (prevProps.frames[i] !== nextProps.frames[i]) {
      return false;
    }
  }

  return true;
};

export const SceneList = memo(SceneListComponent, areEqual);
