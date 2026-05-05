import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import type { Frame } from '@/types/database';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { Image } from '@unpic/react';
import type React from 'react';
import { EvalCellDialog, type DialogTab } from './eval-cell-dialog';
import type { ViewMode } from './eval-view';

/**
 * Get visual prompt from frame - client-safe utility
 * Prioritizes user-updated prompt over AI-generated prompt
 */
export function getVisualPrompt(frame: Frame): string | null {
  if (frame.imagePrompt) {
    return frame.imagePrompt;
  }
  const scene = frame.metadata;
  return scene?.prompts?.visual?.fullPrompt || null;
}

/**
 * Get motion prompt from frame - client-safe utility
 * Prioritizes user-updated prompt over AI-generated prompt
 */
export function getMotionPrompt(frame: Frame): string | null {
  if (frame.motionPrompt) {
    return frame.motionPrompt;
  }
  const scene = frame.metadata;
  return scene?.prompts?.motion?.fullPrompt || null;
}

/**
 * Get original script extract from frame
 */
export function getSceneScript(frame: Frame): string | null {
  const scene = frame.metadata;
  return scene?.originalScript.extract || null;
}

type EvalSceneCellProps = {
  frame: Frame | undefined;
  viewMode: ViewMode;
  sceneNumber: number;
  sequenceTitle: string;
  aspectRatio: AspectRatio;
  framesLoading?: boolean;
  mergedVideoUrl?: string | null;
  mergedVideoPoster?: string | null;
  dialogOpen: boolean;
  dialogInitialTab?: DialogTab;
  onDialogOpenChange: (open: boolean) => void;
  onNavigateLeft?: () => void;
  onNavigateRight?: () => void;
  onNavigateUp?: () => void;
  onNavigateDown?: () => void;
};

export const EvalSceneCell: React.FC<EvalSceneCellProps> = ({
  frame,
  viewMode,
  sceneNumber,
  sequenceTitle,
  aspectRatio,
  framesLoading = false,
  mergedVideoUrl,
  mergedVideoPoster,
  dialogOpen,
  dialogInitialTab,
  onDialogOpenChange,
  onNavigateLeft,
  onNavigateRight,
  onNavigateUp,
  onNavigateDown,
}) => {
  const initialTab: DialogTab = dialogInitialTab ?? viewMode;
  // Empty cell for missing frames — show skeleton while frames are still
  // loading, otherwise show the "No scene N" placeholder.
  if (!frame) {
    if (framesLoading) {
      return (
        <div className="border-b p-2 h-full">
          <Skeleton className="w-full h-full" />
        </div>
      );
    }
    return (
      <div className="border-b p-2 flex items-center justify-center h-full">
        <div className="w-full h-full border-2 border-dashed border-muted rounded-md flex items-center justify-center text-xs text-muted-foreground">
          No scene {sceneNumber}
        </div>
      </div>
    );
  }

  const prompt = getVisualPrompt(frame);
  const motionPrompt = getMotionPrompt(frame);
  const script = getSceneScript(frame);

  const handleClick = () => onDialogOpenChange(true);

  // Images view
  if (viewMode === 'images') {
    if (!frame.thumbnailUrl) {
      return (
        <div className="border-b p-2 h-full flex items-center justify-center">
          {frame.thumbnailStatus === 'generating' ? (
            <Skeleton className="w-full h-full" />
          ) : (
            <div className="text-xs text-muted-foreground text-center">
              No image
            </div>
          )}
        </div>
      );
    }

    return (
      <>
        <button
          type="button"
          className="border-b p-2 cursor-pointer hover:bg-muted/50 transition-colors h-full flex flex-col min-h-0 overflow-hidden w-full text-left appearance-none bg-transparent"
          onClick={handleClick}
        >
          <div className="flex-1 flex items-center justify-center min-h-0">
            <Image
              src={frame.thumbnailUrl}
              alt={`Scene ${sceneNumber}`}
              className="max-w-full max-h-full object-contain rounded-md"
              loading="lazy"
              width={1000}
              height={1000}
            />
          </div>
        </button>
        <EvalCellDialog
          open={dialogOpen}
          onOpenChange={onDialogOpenChange}
          frame={frame}
          sceneNumber={sceneNumber}
          sequenceTitle={sequenceTitle}
          aspectRatio={aspectRatio}
          initialTab={initialTab}
          mergedVideoUrl={mergedVideoUrl}
          mergedVideoPoster={mergedVideoPoster}
          onNavigateLeft={onNavigateLeft}
          onNavigateRight={onNavigateRight}
          onNavigateUp={onNavigateUp}
          onNavigateDown={onNavigateDown}
        />
      </>
    );
  }

  // Script view
  if (viewMode === 'script') {
    if (!script) {
      return (
        <div className="border-b p-2 h-full flex items-center justify-center">
          <div className="text-xs text-muted-foreground">No script</div>
        </div>
      );
    }

    return (
      <>
        <button
          type="button"
          className="border-b p-2 cursor-pointer hover:bg-muted/50 transition-colors h-full flex flex-col min-h-0 overflow-hidden w-full text-left appearance-none bg-transparent"
          onClick={handleClick}
        >
          <ScrollArea className="flex-1 w-full min-h-0">
            <p className="text-xs leading-relaxed whitespace-pre-wrap pr-2">
              {script}
            </p>
          </ScrollArea>
        </button>
        <EvalCellDialog
          open={dialogOpen}
          onOpenChange={onDialogOpenChange}
          frame={frame}
          sceneNumber={sceneNumber}
          sequenceTitle={sequenceTitle}
          aspectRatio={aspectRatio}
          initialTab={initialTab}
          mergedVideoUrl={mergedVideoUrl}
          mergedVideoPoster={mergedVideoPoster}
          onNavigateLeft={onNavigateLeft}
          onNavigateRight={onNavigateRight}
          onNavigateUp={onNavigateUp}
          onNavigateDown={onNavigateDown}
        />
      </>
    );
  }

  // Motion view (individual frame videos)
  if (viewMode === 'motion') {
    if (!frame.videoUrl) {
      const isGenerating = frame.videoStatus === 'generating';

      if (frame.thumbnailUrl) {
        return (
          <>
            <button
              type="button"
              className="border-b p-2 cursor-pointer hover:bg-muted/50 transition-colors h-full flex flex-col min-h-0 overflow-hidden w-full text-left appearance-none bg-transparent"
              onClick={handleClick}
            >
              <div className="relative flex-1 flex items-center justify-center min-h-0">
                <Image
                  src={frame.thumbnailUrl}
                  alt={`Scene ${sceneNumber} preview`}
                  className="max-w-full max-h-full object-contain rounded-md opacity-60"
                  loading="lazy"
                  width={1000}
                  height={1000}
                />
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  <span className="text-xs font-medium text-foreground bg-background/80 backdrop-blur-sm px-2 py-1 rounded-md border">
                    {isGenerating ? 'Generating video…' : 'No video yet'}
                  </span>
                </div>
              </div>
            </button>
            <EvalCellDialog
              open={dialogOpen}
              onOpenChange={onDialogOpenChange}
              frame={frame}
              sceneNumber={sceneNumber}
              sequenceTitle={sequenceTitle}
              aspectRatio={aspectRatio}
              initialTab={initialTab}
              mergedVideoUrl={mergedVideoUrl}
              mergedVideoPoster={mergedVideoPoster}
              onNavigateLeft={onNavigateLeft}
              onNavigateRight={onNavigateRight}
              onNavigateUp={onNavigateUp}
              onNavigateDown={onNavigateDown}
            />
          </>
        );
      }

      return (
        <div className="border-b p-2 h-full flex items-center justify-center">
          {isGenerating ? (
            <Skeleton className="w-full h-full" />
          ) : (
            <div className="text-xs text-muted-foreground text-center">
              No video
            </div>
          )}
        </div>
      );
    }

    return (
      <>
        <button
          type="button"
          className="border-b p-2 cursor-pointer hover:bg-muted/50 transition-colors h-full flex flex-col min-h-0 overflow-hidden w-full text-left appearance-none bg-transparent"
          onClick={handleClick}
        >
          <div className="flex-1 flex items-center justify-center min-h-0">
            <video
              src={frame.videoUrl}
              poster={frame.thumbnailUrl ?? undefined}
              className="max-w-full max-h-full object-contain rounded-md"
              muted
              loop
              playsInline
              onMouseEnter={(e) => void e.currentTarget.play()}
              onMouseLeave={(e) => {
                e.currentTarget.pause();
                e.currentTarget.currentTime = 0;
              }}
            />
          </div>
        </button>
        <EvalCellDialog
          open={dialogOpen}
          onOpenChange={onDialogOpenChange}
          frame={frame}
          sceneNumber={sceneNumber}
          sequenceTitle={sequenceTitle}
          aspectRatio={aspectRatio}
          initialTab={initialTab}
          mergedVideoUrl={mergedVideoUrl}
          mergedVideoPoster={mergedVideoPoster}
          onNavigateLeft={onNavigateLeft}
          onNavigateRight={onNavigateRight}
          onNavigateUp={onNavigateUp}
          onNavigateDown={onNavigateDown}
        />
      </>
    );
  }

  // Prompts view (default) — shows both visual and motion prompts
  if (!prompt && !motionPrompt) {
    return (
      <div className="border-b p-2 h-full flex items-center justify-center">
        <div className="text-xs text-muted-foreground">No prompts</div>
      </div>
    );
  }

  return (
    <>
      <button
        type="button"
        className="border-b p-2 cursor-pointer hover:bg-muted/50 transition-colors h-full flex flex-col min-h-0 w-full text-left appearance-none bg-transparent"
        onClick={handleClick}
      >
        <ScrollArea className="flex-1 w-full min-h-0">
          {prompt && (
            <p className="text-xs leading-relaxed whitespace-pre-wrap pr-2">
              {prompt}
            </p>
          )}
          {prompt && motionPrompt && <hr className="my-1.5 border-muted" />}
          {motionPrompt && (
            <p className="text-xs leading-relaxed whitespace-pre-wrap pr-2 text-muted-foreground">
              {motionPrompt}
            </p>
          )}
        </ScrollArea>
      </button>
      <EvalCellDialog
        open={dialogOpen}
        onOpenChange={onDialogOpenChange}
        frame={frame}
        sceneNumber={sceneNumber}
        sequenceTitle={sequenceTitle}
        aspectRatio={aspectRatio}
        initialTab={initialTab}
        mergedVideoUrl={mergedVideoUrl}
        mergedVideoPoster={mergedVideoPoster}
        onNavigateLeft={onNavigateLeft}
        onNavigateRight={onNavigateRight}
        onNavigateUp={onNavigateUp}
        onNavigateDown={onNavigateDown}
      />
    </>
  );
};
