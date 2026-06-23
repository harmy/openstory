import { MotionModelSelector } from '@/components/model/motion-model-selector';
import { MusicModelSelector } from '@/components/model/music-model-selector';
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
import {
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  videoModelSupportsAudio,
  type AudioModel,
  type ImageToVideoModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { cn } from '@/lib/utils';
import type { Shot } from '@/types/database';
import { ChevronUp, Loader2, Video } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { BatchGenerateMotionArgs } from './scene-list';
import { SceneListItem } from './scene-list-item';
import { SceneThumbnail } from './scene-thumbnail';

type MobileSceneDrawerProps = {
  shots?: Shot[];
  selectedFrameId?: string;
  aspectRatio: AspectRatio;
  onSelectShot: (shotId: string) => void;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  onBatchGenerateMotion?: (args: BatchGenerateMotionArgs) => Promise<void>;
  musicPromptsReady: boolean;
  /** Hide the batch motion button (e.g. while auto-generate motion is in flight). */
  hideBatchButton?: boolean;
  /** Initial motion model for the batch selector (from `sequence.videoModel`). */
  initialMotionModel?: ImageToVideoModel;
  /** Initial music model for the batch selector (from `sequence.musicModel`). */
  initialMusicModel?: AudioModel;
  /** Current style category — used to filter style-restricted motion models. */
  styleCategory?: string;
};

const isCompleted = (frame: Shot) => {
  return (
    frame.thumbnailStatus === 'completed' && frame.videoStatus === 'completed'
  );
};

export const MobileSceneDrawer: React.FC<MobileSceneDrawerProps> = ({
  shots,
  selectedFrameId,
  aspectRatio,
  onSelectShot,
  regeneratingImages,
  regeneratingMotion,
  onBatchGenerateMotion,
  musicPromptsReady,
  hideBatchButton = false,
  initialMotionModel,
  initialMusicModel,
  styleCategory,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [includeMusic, setIncludeMusic] = useState(false);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [motionModel, setMotionModel] = useState<ImageToVideoModel>(
    initialMotionModel ?? DEFAULT_VIDEO_MODEL
  );
  const [musicModel, setMusicModel] = useState<AudioModel>(
    initialMusicModel ?? DEFAULT_MUSIC_MODEL
  );

  const motionSupportsAudio = videoModelSupportsAudio(motionModel);

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

  const totalShots = shots?.length ?? 0;

  // Get the currently selected frame
  const selectedFrame = useMemo(
    () => shots?.find((f) => f.id === selectedFrameId),
    [shots, selectedFrameId]
  );

  // Calculate eligible frames for motion generation
  // Include 'generating' status to allow retrying stuck jobs
  const eligibleFrames = useMemo(() => {
    if (!shots) return [];
    return shots.filter(
      (f) =>
        (f.videoStatus === 'pending' ||
          f.videoStatus === 'failed' ||
          f.videoStatus === 'generating') &&
        f.thumbnailStatus === 'completed'
    );
  }, [shots]);

  const handleSelectFrame = (shotId: string) => {
    onSelectShot(shotId);
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

  // Extract scene info for the collapsed bar
  const sceneNumber =
    selectedFrame?.metadata?.sceneNumber ??
    (selectedFrame?.orderIndex ?? 0) + 1;
  const sceneTitle =
    selectedFrame?.metadata?.metadata?.title ?? `Scene ${sceneNumber}`;

  const hasEligibleFrames = eligibleFrames.length > 0;
  const isMotionInProgress = regeneratingMotion.size > 0;
  const showFooter =
    !hideBatchButton && hasEligibleFrames && !isMotionInProgress;
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
              {shots?.length ?? 0} {shots?.length === 1 ? 'Scene' : 'Scenes'}
            </SheetTitle>
          </SheetHeader>

          <ScrollArea className="flex-1 min-h-0 -mx-4">
            <div className="flex flex-col gap-3 px-4 py-2">
              {(shots === undefined || shots.length === 0) &&
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

              {shots?.map((frame) => (
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
              <div className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">
                  Motion model
                </span>
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
                  <span className="text-xs text-muted-foreground">
                    Music model
                  </span>
                  <MusicModelSelector
                    selectedModel={musicModel}
                    onModelChange={setMusicModel}
                    disabled={isGenerating || isMotionInProgress}
                  />
                </div>
              )}
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
                    Generate {eligibleFrames.length} / {totalShots}{' '}
                    {totalShots === 1 ? 'shot' : 'shots'}
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
              {motionSupportsAudio && (
                <label
                  htmlFor="mobile-batch-generate-audio"
                  className="flex items-center gap-2 text-sm text-muted-foreground justify-center"
                >
                  <Checkbox
                    id="mobile-batch-generate-audio"
                    checked={generateAudio}
                    onCheckedChange={(checked) =>
                      setGenerateAudio(checked === true)
                    }
                  />
                  <span>Include SFX &amp; dialogue</span>
                </label>
              )}
            </SheetFooter>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
};
