import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { cn } from '@/lib/utils';
import type { Frame } from '@/types/database';
import { Check, Loader2 } from 'lucide-react';
import { memo } from 'react';
import { SceneThumbnail } from './scene-thumbnail';

type SceneListItemProps = {
  frame?: Frame | undefined;
  aspectRatio: AspectRatio;
  isActive?: boolean;
  isCompleted?: boolean;
  onSelect?: () => void;
  variant?: 'stacked' | 'horizontal' | 'responsive';
  isRegeneratingImage?: boolean;
  isRegeneratingMotion?: boolean;
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
}) => {
  // Extract scene data from frame metadata
  const metadata = frame?.metadata;

  const sceneNumber = metadata?.sceneNumber ?? (frame?.orderIndex ?? 0) + 1;
  const title = !frame
    ? undefined
    : (metadata?.metadata?.title ?? `Scene ${sceneNumber}`);
  const scriptPreview = !frame
    ? undefined
    : (metadata?.originalScript.extract ?? frame.description ?? '');

  return (
    <Card
      className={cn(
        '@container/scene relative cursor-pointer transition-all',
        isActive ? 'border-primary bg-primary/5' : 'hover:bg-muted/50',
        variant === 'responsive' && '@[280px]/scene:py-3',
        variant === 'horizontal' && 'py-3',
        'py-3'
      )}
      onClick={onSelect}
    >
      {isCompleted && (
        <Check
          className={cn(
            'absolute right-4 top-4 z-10 h-6 w-6 p-1 rounded-full',
            'bg-success text-success-foreground'
          )}
        />
      )}
      {frame &&
        !isCompleted &&
        (isRegeneratingImage || isRegeneratingMotion) && (
          <Loader2
            className={cn(
              'absolute right-4 top-4 z-10 h-6 w-6 p-1 rounded-full animate-spin',
              'bg-primary/10 text-primary'
            )}
          />
        )}
      {frame &&
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
          <SceneThumbnail
            thumbnailUrl={frame?.thumbnailUrl}
            previewThumbnailUrl={frame?.previewThumbnailUrl}
            thumbnailStatus={frame?.thumbnailStatus || undefined}
            alt={title ?? 'Scene thumbnail'}
            aspectRatio={aspectRatio}
            className={cn(
              'w-full rounded-md',
              // Portrait (9:16) uses smaller width to reduce height
              aspectRatio === '9:16' && [
                variant === 'responsive' &&
                  '@[280px]/scene:w-20 @[280px]/scene:shrink-0',
                variant === 'horizontal' && 'w-20 shrink-0',
              ],
              // Landscape (16:9) and square (1:1) use standard width
              aspectRatio !== '9:16' && [
                variant === 'responsive' &&
                  '@[280px]/scene:w-32 @[280px]/scene:shrink-0',
                variant === 'horizontal' && 'w-32 shrink-0',
              ]
            )}
          />

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
    prevProps.isRegeneratingMotion !== nextProps.isRegeneratingMotion
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
