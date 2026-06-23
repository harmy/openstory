import { DivergentAlternateBanner } from '@/components/staleness/divergent-alternate-banner';
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { cn } from '@/lib/utils';
import { stripMarkdown } from '@/lib/utils/markdown-plain';
import type { Shot } from '@/types/database';
import { Check, Loader2 } from 'lucide-react';
import { memo } from 'react';
import { SceneThumbnail } from './scene-thumbnail';

type SceneListItemProps = {
  frame?: Shot | undefined;
  aspectRatio: AspectRatio;
  isActive?: boolean;
  isCompleted?: boolean;
  onSelect?: () => void;
  variant?: 'stacked' | 'horizontal' | 'responsive';
  isRegeneratingImage?: boolean;
  isRegeneratingMotion?: boolean;
  /**
   * Set when the frame has a divergent alternate thumbnail awaiting review.
   * Takes precedence over the staleness dot per the divergence-resolution
   * spec — promoting the alternate resolves both states.
   */
  divergentVariantId?: string;
  onCompareDivergent?: () => void;
  /** Pinned image model hasn't generated this scene (#547) — show a badge. */
  modelMissing?: boolean;
  /** Name of the pinned image model, for the "No {model}" badge. */
  modelMissingLabel?: string | null;
};

const SceneListItemComponent: React.FC<SceneListItemProps> = ({
  frame,
  aspectRatio,
  isActive = false,
  isCompleted = false,
  onSelect,
  variant = 'responsive',
  isRegeneratingImage = false,
  isRegeneratingMotion = false,
  divergentVariantId,
  onCompareDivergent,
  modelMissing = false,
  modelMissingLabel,
}) => {
  // Divergent alternate takes precedence: promoting it resolves staleness too.
  const showDivergentDot = !!divergentVariantId;
  const showStatusIndicator =
    !showDivergentDot &&
    (isCompleted ||
      (frame && (isRegeneratingImage || isRegeneratingMotion || !isCompleted)));
  // Extract scene data from frame metadata
  const metadata = frame?.metadata;

  const sceneNumber = metadata?.sceneNumber ?? (frame?.orderIndex ?? 0) + 1;
  const title = !frame
    ? undefined
    : (metadata?.metadata?.title ?? `Scene ${sceneNumber}`);
  const scriptPreview = !frame
    ? undefined
    : stripMarkdown(
        metadata?.originalScript.extract ?? frame.description ?? ''
      );

  // Skeleton state (no frame): suppress click handling and pointer cursor so
  // a click during the loading window does not invoke the (now-undefined)
  // onSelect callback or appear interactive.
  const isSkeleton = !frame;
  return (
    <Card
      data-testid="scene-list-item"
      data-frame-id={frame?.id}
      className={cn(
        '@container/scene relative transition-all',
        isSkeleton ? 'pointer-events-none' : 'cursor-pointer',
        isActive ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
        variant === 'responsive' && '@[280px]/scene:py-3',
        variant === 'horizontal' && 'py-3',
        'py-3'
      )}
      onClick={isSkeleton ? undefined : onSelect}
    >
      {showDivergentDot && (
        <div
          className="absolute right-3 top-3 z-10"
          // The corner indicator is itself a focusable button; this wrapper
          // exists only to halt click propagation so opening the dot doesn't
          // also select the scene card behind it.
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
          role="presentation"
        >
          <DivergentAlternateBanner
            density="corner-dot"
            variantId={divergentVariantId}
            artifact="thumbnail"
            entityType="shot"
            onCompare={() => onCompareDivergent?.()}
            // Compare-only entry from the corner; promote/discard live in the dialog.
            onPromote={() => onCompareDivergent?.()}
            onDiscard={() => onCompareDivergent?.()}
          />
        </div>
      )}
      {showStatusIndicator && isCompleted && (
        <Check
          className={cn(
            'absolute right-4 top-4 z-10 h-6 w-6 p-1 rounded-full',
            'bg-success text-success-foreground'
          )}
        />
      )}
      {showStatusIndicator &&
        frame &&
        !isCompleted &&
        (isRegeneratingImage || isRegeneratingMotion) && (
          <Loader2
            className={cn(
              'absolute right-4 top-4 z-10 h-6 w-6 p-1 rounded-full animate-spin',
              'bg-primary/10 text-primary'
            )}
          />
        )}
      {showStatusIndicator &&
        frame &&
        !isCompleted &&
        !isRegeneratingImage &&
        !isRegeneratingMotion && (
          <Skeleton className="absolute right-4 top-4 z-10 h-6 w-6 rounded-full" />
        )}

      <CardHeader>
        <div
          className={cn(
            'flex flex-col gap-3',
            variant === 'responsive' &&
              '@[280px]/scene:flex-row @[280px]/scene:gap-4',
            variant === 'horizontal' && 'flex-row gap-4'
          )}
        >
          <div
            className={cn(
              'relative w-full',
              aspectRatio === '9:16' && [
                variant === 'responsive' &&
                  '@[280px]/scene:w-20 @[280px]/scene:shrink-0',
                variant === 'horizontal' && 'w-20 shrink-0',
              ],
              aspectRatio !== '9:16' && [
                variant === 'responsive' &&
                  '@[280px]/scene:w-32 @[280px]/scene:shrink-0',
                variant === 'horizontal' && 'w-32 shrink-0',
              ]
            )}
          >
            <SceneThumbnail
              thumbnailUrl={frame?.thumbnailUrl}
              previewThumbnailUrl={frame?.previewThumbnailUrl}
              thumbnailStatus={frame?.thumbnailStatus || undefined}
              alt={title ?? 'Scene thumbnail'}
              aspectRatio={aspectRatio}
              className="w-full rounded-md"
            />
            {modelMissing && (
              <span
                className="absolute bottom-1 left-1 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-medium leading-none text-white"
                aria-label={
                  modelMissingLabel
                    ? `Not generated with ${modelMissingLabel}`
                    : 'Not generated with the selected model'
                }
              >
                No {modelMissingLabel}
              </span>
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <CardTitle className="text-sm">
              {title ?? <Skeleton className="w-24 h-4" />}
            </CardTitle>
            <CardDescription className="line-clamp-4 text-xs leading-snug">
              {scriptPreview ?? <Skeleton className="w-full h-4" />}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
    </Card>
  );
};

// Custom equality check to prevent unnecessary re-renders during polling
// Only re-render if the fields that affect the UI actually change
const areEqual = (
  prevProps: SceneListItemProps,
  nextProps: SceneListItemProps
): boolean => {
  // Compare primitive props
  if (
    prevProps.aspectRatio !== nextProps.aspectRatio ||
    prevProps.isActive !== nextProps.isActive ||
    prevProps.isCompleted !== nextProps.isCompleted ||
    prevProps.variant !== nextProps.variant ||
    prevProps.isRegeneratingImage !== nextProps.isRegeneratingImage ||
    prevProps.isRegeneratingMotion !== nextProps.isRegeneratingMotion ||
    prevProps.divergentVariantId !== nextProps.divergentVariantId ||
    prevProps.modelMissing !== nextProps.modelMissing ||
    prevProps.modelMissingLabel !== nextProps.modelMissingLabel
  ) {
    return false;
  }

  // If both frames are undefined, they're equal
  if (!prevProps.frame && !nextProps.frame) {
    return true;
  }

  // If one is undefined and the other isn't, they're not equal
  if (!prevProps.frame || !nextProps.frame) {
    return false;
  }

  // Compare frame fields that affect rendering
  const prevFrame = prevProps.frame;
  const nextFrame = nextProps.frame;

  // Check if frame identity changed
  if (prevFrame.id !== nextFrame.id) {
    return false;
  }

  // Check thumbnail-related fields
  if (
    prevFrame.thumbnailUrl !== nextFrame.thumbnailUrl ||
    prevFrame.previewThumbnailUrl !== nextFrame.previewThumbnailUrl ||
    prevFrame.thumbnailStatus !== nextFrame.thumbnailStatus
  ) {
    return false;
  }

  // Check video-related fields (for skeleton/completion state)
  if (
    prevFrame.videoUrl !== nextFrame.videoUrl ||
    prevFrame.videoStatus !== nextFrame.videoStatus
  ) {
    return false;
  }

  // Check metadata fields used in render
  if (prevFrame.orderIndex !== nextFrame.orderIndex) {
    return false;
  }

  if (prevFrame.description !== nextFrame.description) {
    return false;
  }

  // Check metadata object (scene data)
  const prevMetadata = prevFrame.metadata;
  const nextMetadata = nextFrame.metadata;

  if (!prevMetadata && !nextMetadata) {
    return true;
  }

  if (!prevMetadata || !nextMetadata) {
    return false;
  }

  // Compare the metadata fields we use: sceneNumber, title, script extract
  if (
    prevMetadata.sceneNumber !== nextMetadata.sceneNumber ||
    prevMetadata.metadata?.title !== nextMetadata.metadata?.title ||
    prevMetadata.originalScript.extract !== nextMetadata.originalScript.extract
  ) {
    return false;
  }

  // All checks passed - props are equal
  return true;
};

export const SceneListItem = memo(SceneListItemComponent, areEqual);
