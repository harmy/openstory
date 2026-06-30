import { MusicModelSelector } from '@/components/model/music-model-selector';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { DEFAULT_MUSIC_MODEL, type AudioModel } from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { ShotVariant } from '@/lib/db/schema';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import { Loader2, Video } from 'lucide-react';
import { memo, useMemo, useRef, useState } from 'react';
import { SceneListItem } from './scene-list-item';

export type BatchGenerateMotionArgs = {
  includeMusic: boolean;
  musicModel: AudioModel;
  /** Lets the user suppress model-emitted audio (sfx/dialogue/ambient) for the
   *  batch. The flag is honored only by models that produce audio — non-audio
   *  models ignore it downstream during motion-prompt assembly. */
  generateAudio: boolean;
};

type SceneListProps = {
  shots?: ShotWithImage[] | undefined;
  selectedShotId?: string;
  aspectRatio: AspectRatio;
  onSelectShot: (shotId: string) => void;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  onBatchGenerateMotion?: (args: BatchGenerateMotionArgs) => Promise<void>;
  musicPromptsReady: boolean;
  /** Hide the batch motion button (e.g. while auto-generate motion is in flight). */
  hideBatchButton?: boolean;
  /** Live divergent alternates for the current sequence (filtered per-shot). */
  divergentVariants?: ShotVariant[];
  onCompareDivergent?: (variant: ShotVariant) => void;
  /** Initial music model for the batch selector (from `sequence.musicModel`). */
  initialMusicModel?: AudioModel;
  /**
   * Scenes the pinned image model hasn't generated yet (#547). Those cards show
   * a "No {model}" badge so the thumbnail (which still shows the primary image)
   * isn't mistaken for the pinned model's output.
   */
  modelMissingShotIds?: Set<string>;
  /** Name of the pinned image model, for the per-card "No {model}" badge. */
  modelMissingLabel?: string | null;
};

const isCompleted = (shot: ShotWithImage) =>
  shot.thumbnailStatus === 'completed' && shot.videoStatus === 'completed';

const SceneListComponent: React.FC<SceneListProps> = ({
  shots,
  selectedShotId,
  aspectRatio,
  onSelectShot,
  regeneratingImages,
  regeneratingMotion,
  onBatchGenerateMotion,
  musicPromptsReady,
  hideBatchButton = false,
  divergentVariants,
  onCompareDivergent,
  initialMusicModel,
  modelMissingShotIds,
  modelMissingLabel,
}) => {
  const divergentByShotId = useMemo(() => {
    const map = new Map<string, ShotVariant>();
    for (const v of divergentVariants ?? []) {
      // Image variant is what surfaces on the card. Other variant types
      // live on their respective tabs per the spec's surfacing matrix.
      if (v.variantType !== 'image') continue;
      if (!map.has(v.shotId)) map.set(v.shotId, v);
    }
    return map;
  }, [divergentVariants]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [includeMusic, setIncludeMusic] = useState(true);
  const [generateAudio, setGenerateAudio] = useState(true);
  const [musicModel, setMusicModel] = useState<AudioModel>(
    initialMusicModel ?? DEFAULT_MUSIC_MODEL
  );

  // Sync local selection when the sequence's saved model changes from outside
  // (e.g. after generation completes and the workflow persists the new model).
  const prevInitialMusicRef = useRef(initialMusicModel);
  if (initialMusicModel && initialMusicModel !== prevInitialMusicRef.current) {
    prevInitialMusicRef.current = initialMusicModel;
    setMusicModel(initialMusicModel);
  }

  const totalShots = shots?.length ?? 0;

  // Shots that need to be kicked off (not already generating)
  const notStartedShots = useMemo(() => {
    if (!shots) return [];
    return shots.filter(
      (f) =>
        (f.videoStatus === 'pending' || f.videoStatus === 'failed') &&
        f.thumbnailStatus === 'completed'
    );
  }, [shots]);

  const hasGeneratingShots = useMemo(() => {
    if (!shots) return false;
    return shots.some(
      (f) => f.videoStatus === 'generating' && f.thumbnailStatus === 'completed'
    );
  }, [shots]);

  // Check if all eligible shots have motion prompts ready
  const motionPromptsReady = useMemo(() => {
    if (!notStartedShots.length) return true;
    return notStartedShots.every(
      (f) => f.motionPrompt || f.motionPromptData?.fullPrompt
    );
  }, [notStartedShots]);

  const handleGenerateMotion = async () => {
    if (!onBatchGenerateMotion || notStartedShots.length === 0) return;

    setIsGenerating(true);
    try {
      await onBatchGenerateMotion({
        includeMusic,
        musicModel,
        generateAudio,
      });
    } finally {
      setIsGenerating(false);
    }
  };

  const isMotionInProgress = regeneratingMotion.size > 0 || hasGeneratingShots;
  const showButton =
    !hideBatchButton && notStartedShots.length > 0 && !isMotionInProgress;
  const isButtonDisabled =
    isGenerating ||
    notStartedShots.length === 0 ||
    !motionPromptsReady ||
    (includeMusic && !musicPromptsReady);

  const renderShotCard = (shot: ShotWithImage) => {
    const divergent = divergentByShotId.get(shot.id);
    return (
      <SceneListItem
        key={shot.id}
        shot={shot}
        aspectRatio={aspectRatio}
        isActive={shot.id === selectedShotId}
        isCompleted={isCompleted(shot)}
        onSelect={() => onSelectShot(shot.id)}
        isRegeneratingImage={regeneratingImages.has(shot.id)}
        isRegeneratingMotion={regeneratingMotion.has(shot.id)}
        divergentVariantId={divergent?.id}
        onCompareDivergent={
          divergent ? () => onCompareDivergent?.(divergent) : undefined
        }
        modelMissing={
          !!modelMissingLabel && (modelMissingShotIds?.has(shot.id) ?? false)
        }
        modelMissingLabel={modelMissingLabel}
      />
    );
  };

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
          {(shots === undefined || shots.length === 0) &&
            [1, 2, 3].map((i) => (
              <SceneListItem
                key={`shot-skeleton-${i}`}
                shot={undefined}
                aspectRatio={aspectRatio}
                isActive={false}
                isCompleted={false}
              />
            ))}

          {shots && shots.map(renderShotCard)}
        </div>
      </ScrollArea>

      {/* Sticky footer with Generate Motion button */}
      {showButton && (
        <div className="sticky bottom-0 border-t bg-background p-4 flex flex-col gap-3">
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
            {isGenerating ? (
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
                Generate {notStartedShots.length} / {totalShots}{' '}
                {totalShots === 1 ? 'shot' : 'shots'}
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
          <label
            htmlFor="batch-generate-audio"
            className="flex items-center gap-2 text-sm text-muted-foreground"
          >
            <Checkbox
              id="batch-generate-audio"
              checked={generateAudio}
              onCheckedChange={(checked) => setGenerateAudio(checked === true)}
            />
            <span>Include SFX &amp; dialogue (when the model supports it)</span>
          </label>
        </div>
      )}
    </div>
  );
};

// Custom equality check to prevent unnecessary re-renders during polling.
// Relies on TanStack Query's structural sharing to preserve object references.
const areEqual = (
  prevProps: SceneListProps,
  nextProps: SceneListProps
): boolean => {
  if (
    prevProps.selectedShotId !== nextProps.selectedShotId ||
    prevProps.aspectRatio !== nextProps.aspectRatio ||
    prevProps.musicPromptsReady !== nextProps.musicPromptsReady ||
    prevProps.initialMusicModel !== nextProps.initialMusicModel ||
    prevProps.modelMissingLabel !== nextProps.modelMissingLabel ||
    prevProps.modelMissingShotIds !== nextProps.modelMissingShotIds
  ) {
    return false;
  }

  if (
    prevProps.regeneratingImages !== nextProps.regeneratingImages ||
    prevProps.regeneratingMotion !== nextProps.regeneratingMotion
  ) {
    return false;
  }

  if (
    prevProps.onBatchGenerateMotion !== nextProps.onBatchGenerateMotion ||
    prevProps.onCompareDivergent !== nextProps.onCompareDivergent
  ) {
    return false;
  }

  if (prevProps.divergentVariants !== nextProps.divergentVariants) {
    return false;
  }

  // TanStack Query's structural sharing keeps the array reference stable when
  // the contents are unchanged, so reference equality is sufficient.
  if (prevProps.shots === nextProps.shots) {
    return true;
  }
  if (!prevProps.shots || !nextProps.shots) {
    return false;
  }
  if (prevProps.shots.length !== nextProps.shots.length) {
    return false;
  }
  for (let i = 0; i < prevProps.shots.length; i++) {
    if (prevProps.shots[i] !== nextProps.shots[i]) {
      return false;
    }
  }

  return true;
};

export const SceneList = memo(SceneListComponent, areEqual);
