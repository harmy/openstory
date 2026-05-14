import { MotionModelSelector } from '@/components/model/motion-model-selector';
import { MusicModelSelector } from '@/components/model/music-model-selector';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  videoModelSupportsAudio,
  type AudioModel,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { Frame, FrameVariant } from '@/lib/db/schema';
import { Loader2, Video } from 'lucide-react';
import { memo, useMemo, useRef, useState } from 'react';
import { SceneListItem } from './scene-list-item';

export type BatchGenerateMotionArgs = {
  includeMusic: boolean;
  motionModel: ImageToVideoModel;
  musicModel: AudioModel;
  /** When the motion model emits audio (sfx/dialogue/ambient), allow the
   *  user to suppress it. Ignored for models without audio output. */
  generateAudio: boolean;
};

type SceneListProps = {
  frames?: Frame[] | undefined;
  selectedFrameId?: string;
  aspectRatio: AspectRatio;
  onSelectFrame: (frameId: string) => void;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  onBatchGenerateMotion?: (args: BatchGenerateMotionArgs) => Promise<void>;
  musicPromptsReady: boolean;
  /** Hide the batch motion button (e.g. while auto-generate motion is in flight). */
  hideBatchButton?: boolean;
  /** Live divergent alternates for the current sequence (filtered per-frame). */
  divergentVariants?: FrameVariant[];
  onCompareDivergent?: (variant: FrameVariant) => void;
  /** Initial motion model for the batch selector (from `sequence.videoModel`). */
  initialMotionModel?: ImageToVideoModel;
  /** Initial music model for the batch selector (from `sequence.musicModel`). */
  initialMusicModel?: AudioModel;
  /** Current style category — used to filter style-restricted motion models. */
  styleCategory?: string;
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
  divergentVariants,
  onCompareDivergent,
  initialMotionModel,
  initialMusicModel,
  styleCategory,
}) => {
  const divergentByFrameId = useMemo(() => {
    const map = new Map<string, FrameVariant>();
    for (const v of divergentVariants ?? []) {
      // Image variant is what surfaces on the card. Other variant types
      // live on their respective tabs per the spec's surfacing matrix.
      if (v.variantType !== 'image') continue;
      if (!map.has(v.frameId)) map.set(v.frameId, v);
    }
    return map;
  }, [divergentVariants]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [includeMusic, setIncludeMusic] = useState(true);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [motionModel, setMotionModel] = useState<ImageToVideoModel>(
    initialMotionModel ?? DEFAULT_VIDEO_MODEL
  );
  const [musicModel, setMusicModel] = useState<AudioModel>(
    initialMusicModel ?? DEFAULT_MUSIC_MODEL
  );

  const motionSupportsAudio = videoModelSupportsAudio(motionModel);

  // Sync local selection when the sequence's saved model changes from outside
  // (e.g. after generation completes and the workflow persists the new model).
  const prevInitialMotionRef = useRef(initialMotionModel);
  if (
    initialMotionModel &&
    initialMotionModel !== prevInitialMotionRef.current
  ) {
    prevInitialMotionRef.current = initialMotionModel;
    setMotionModel(initialMotionModel);
  }
  const prevInitialMusicRef = useRef(initialMusicModel);
  if (initialMusicModel && initialMusicModel !== prevInitialMusicRef.current) {
    prevInitialMusicRef.current = initialMusicModel;
    setMusicModel(initialMusicModel);
  }

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
      await onBatchGenerateMotion({
        includeMusic,
        motionModel,
        musicModel,
        generateAudio: motionSupportsAudio ? generateAudio : false,
      });
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
              />
            ))}

          {frames &&
            frames.map((frame) => {
              const divergent = divergentByFrameId.get(frame.id);
              return (
                <SceneListItem
                  key={frame.id}
                  frame={frame}
                  aspectRatio={aspectRatio}
                  isActive={frame.id === selectedFrameId}
                  isCompleted={isCompleted(frame)}
                  onSelect={() => onSelectFrame(frame.id)}
                  isRegeneratingImage={regeneratingImages.has(frame.id)}
                  isRegeneratingMotion={regeneratingMotion.has(frame.id)}
                  divergentVariantId={divergent?.id}
                  onCompareDivergent={
                    divergent
                      ? () => onCompareDivergent?.(divergent)
                      : undefined
                  }
                />
              );
            })}
        </div>
      </ScrollArea>

      {/* Sticky footer with Generate Motion button */}
      {showButton && (
        <div className="sticky bottom-0 border-t bg-background p-4 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <span className="text-xs text-muted-foreground">Motion model</span>
            <MotionModelSelector
              selectedModel={motionModel}
              onModelChange={setMotionModel}
              disabled={isGenerating || isMotionInProgress}
              aspectRatio={aspectRatio}
              styleCategory={styleCategory}
            />
          </div>
          {includeMusic && (
            <div className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Music model</span>
              <MusicModelSelector
                selectedModel={musicModel}
                onModelChange={setMusicModel}
                disabled={isGenerating || isMotionInProgress}
              />
            </div>
          )}
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
          {motionSupportsAudio && (
            <label
              htmlFor="batch-generate-audio"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Checkbox
                id="batch-generate-audio"
                checked={generateAudio}
                onCheckedChange={(checked) =>
                  setGenerateAudio(checked === true)
                }
              />
              <span>Include SFX &amp; dialogue</span>
            </label>
          )}
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
    prevProps.musicPromptsReady !== nextProps.musicPromptsReady ||
    prevProps.initialMotionModel !== nextProps.initialMotionModel ||
    prevProps.initialMusicModel !== nextProps.initialMusicModel ||
    prevProps.styleCategory !== nextProps.styleCategory
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
  if (
    prevProps.onBatchGenerateMotion !== nextProps.onBatchGenerateMotion ||
    prevProps.onCompareDivergent !== nextProps.onCompareDivergent
  ) {
    return false;
  }

  // Divergent / staleness inputs drive corner-dot indicators on each row.
  // TanStack Query structural sharing keeps the array reference stable when
  // contents are unchanged, so reference equality is sufficient here.
  if (prevProps.divergentVariants !== nextProps.divergentVariants) {
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
