import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { cn } from '@/lib/utils';
import type { Frame } from '@/types/database';
import { ChevronUp, Loader2, Video } from 'lucide-react';
import { useMemo, useState } from 'react';
import { SceneListItem } from './scene-list-item';
import { SceneThumbnail } from './scene-thumbnail';

type MobileSceneDrawerProps = {
  frames?: Frame[];
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
  return (
    frame.thumbnailStatus === 'completed' && frame.videoStatus === 'completed'
  );
};

export const MobileSceneDrawer: React.FC<MobileSceneDrawerProps> = ({
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
  const [isOpen, setIsOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [includeMusic, setIncludeMusic] = useState(false);

  const totalFrames = frames?.length ?? 0;

  // Get the currently selected frame
  const selectedFrame = useMemo(
    () => frames?.find((f) => f.id === selectedFrameId),
    [frames, selectedFrameId]
  );

  // Calculate eligible frames for motion generation
  // Include 'generating' status to allow retrying stuck jobs
  const eligibleFrames = useMemo(() => {
    if (!frames) return [];
    return frames.filter(
      (f) =>
        (f.videoStatus === 'pending' ||
          f.videoStatus === 'failed' ||
          f.videoStatus === 'generating') &&
        f.thumbnailStatus === 'completed'
    );
  }, [frames]);

  const handleSelectFrame = (frameId: string) => {
    onSelectFrame(frameId);
    setIsOpen(false);
  };

  // Check if all eligible frames have motion prompts ready
  const motionPromptsReady = useMemo(() => {
    if (!eligibleFrames.length) return true;
    return eligibleFrames.every(
      (f) => f.motionPrompt || f.metadata?.prompts?.motion?.fullPrompt
    );
  }, [eligibleFrames]);

  const handleGenerateMotion = async () => {
    if (!onBatchGenerateMotion || eligibleFrames.length === 0) return;

    setIsGenerating(true);
    try {
      await onBatchGenerateMotion(includeMusic);
    } finally {
      setIsGenerating(false);
    }
  };

  // Extract scene info for the collapsed bar
  const sceneNumber =
    selectedFrame?.metadata?.sceneNumber ??
    (selectedFrame?.orderIndex ?? 0) + 1;
  const sceneTitle =
    selectedFrame?.metadata?.metadata?.title ?? `Scene ${sceneNumber}`;

  const hasEligibleFrames = eligibleFrames.length > 0;
  const isMotionInProgress = regeneratingMotion.size > 0;
  const showFooter =
    !hideBatchButton && (hasEligibleFrames || isMotionInProgress);
  const isButtonDisabled =
    isGenerating ||
    isMotionInProgress ||
    eligibleFrames.length === 0 ||
    !motionPromptsReady ||
    (includeMusic && !musicPromptsReady);

  return (
    <>
      {/* Collapsed bar - fixed at bottom */}
      <button
        type="button"
        onClick={() => setIsOpen(true)}
        className={cn(
          'fixed inset-x-0 bottom-0 z-40 flex items-center gap-3 border-t bg-background px-4 py-3',
          'pb-[calc(0.75rem+env(safe-area-inset-bottom))]',
          'active:bg-muted/50 transition-colors'
        )}
      >
        <SceneThumbnail
          thumbnailUrl={selectedFrame?.thumbnailUrl}
          previewThumbnailUrl={selectedFrame?.previewThumbnailUrl}
          thumbnailStatus={selectedFrame?.thumbnailStatus || undefined}
          alt={sceneTitle}
          aspectRatio={aspectRatio}
          className="h-10 w-10 shrink-0 rounded object-cover"
        />
        <span className="flex-1 truncate text-left text-sm font-medium">
          {selectedFrame ? sceneTitle : 'Select a scene'}
        </span>
        <ChevronUp className="h-5 w-5 shrink-0 text-muted-foreground" />
      </button>

      {/* Expanded sheet */}
      <Sheet open={isOpen} onOpenChange={setIsOpen}>
        <SheetContent
          side="bottom"
          className="flex h-[70vh] flex-col pb-[env(safe-area-inset-bottom)]"
        >
          <SheetHeader>
            <SheetTitle>
              {frames?.length ?? 0} {frames?.length === 1 ? 'Scene' : 'Scenes'}
            </SheetTitle>
          </SheetHeader>

          <ScrollArea className="flex-1 min-h-0 -mx-4">
            <div className="flex flex-col gap-3 px-4 py-2">
              {(frames === undefined || frames.length === 0) &&
                [1, 2, 3].map((i) => (
                  <SceneListItem
                    key={`frame-skeleton-${i}`}
                    frame={undefined}
                    aspectRatio={aspectRatio}
                    isActive={false}
                    isCompleted={false}
                    onSelect={() => {}}
                  />
                ))}

              {frames?.map((frame) => (
                <SceneListItem
                  key={frame.id}
                  frame={frame}
                  aspectRatio={aspectRatio}
                  isActive={frame.id === selectedFrameId}
                  isCompleted={isCompleted(frame)}
                  onSelect={() => handleSelectFrame(frame.id)}
                  isRegeneratingImage={regeneratingImages.has(frame.id)}
                  isRegeneratingMotion={regeneratingMotion.has(frame.id)}
                />
              ))}
            </div>
          </ScrollArea>

          {showFooter && (
            <SheetFooter className="border-t pt-4 px-4 flex-col items-stretch gap-3">
              <Button
                variant="default"
                onClick={() => void handleGenerateMotion()}
                disabled={isButtonDisabled}
              >
                {isGenerating || isMotionInProgress ? (
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
                    Generate {eligibleFrames.length} / {totalFrames}{' '}
                    {totalFrames === 1 ? 'frame' : 'frames'}
                  </>
                )}
              </Button>
              <label className="flex items-center gap-2 text-sm text-muted-foreground justify-center">
                <Checkbox
                  checked={includeMusic}
                  onCheckedChange={(checked) =>
                    setIncludeMusic(checked === true)
                  }
                  disabled={!musicPromptsReady}
                />
                <span>
                  Also generate music
                  {!musicPromptsReady && (
                    <span className="text-xs ml-1">(preparing…)</span>
                  )}
                </span>
              </label>
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
};
