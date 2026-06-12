import { type TabValue } from '@/components/scenes/scene-script-prompts';
import { BlobLoader } from '@/components/ui/blob-loader';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { EmptyState } from '@/components/ui/empty-state';
import { Skeleton } from '@/components/ui/skeleton';
import { useFrameDownloadUrl } from '@/hooks/use-frame-download-url';
import {
  type AspectRatio,
  aspectRatioToDimensions,
  getAspectRatioClassName,
} from '@/lib/constants/aspect-ratios';
import { cn } from '@/lib/utils';
import type { Frame } from '@/types/database';
import { AppImage } from '@/components/ui/app-image';
import {
  AlertCircle,
  Download,
  Link,
  Loader2,
  Share2,
  VideoIcon,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { VideoPlayer } from './video-player';
import { VideoStateOverlay } from './video-state-overlay';

type ScenePlayerProps = {
  frames?: Frame[];
  selectedFrameId?: string;
  aspectRatio: AspectRatio;
  /**
   * Accepted but unused: the player no longer auto-advances between scenes
   * (single-scene review shouldn't roll into the next clip — use Theatre for
   * continuous playback). Frame selection is driven by the scene list.
   */
  onSelectFrame?: (frameId: string) => void;
  className?: string;
  wrapperClassName?: string;
  selectedTab?: TabValue;
  overrideImageUrl?: string | null;
  /**
   * Per-scene video-variant preview (#545). When set (motion tab), the player
   * plays this url for the current frame instead of its primary video — the
   * motion analog of `overrideImageUrl`.
   */
  overrideVideoUrl?: string | null;
  badgeMessage?: string | null;
  /**
   * Warning badge shown when the pinned image model has not generated this
   * scene (#547) — the displayed image is the primary fallback, not the
   * pinned model's output.
   */
  modelMismatchLabel?: string | null;
  progressMessage?: string;
  /**
   * In-flight retry state for the selected frame (#882) — rendered as
   * "Retrying (N/M)…" (or "Retrying…") in the player overlay.
   */
  retry?: { attempt: number; maxAttempts?: number };
  posterUrl?: string;
  onTimeUpdate?: (currentTime: number) => void;
  onEnded?: () => void;
};

export const ScenePlayer: React.FC<ScenePlayerProps> = ({
  frames,
  className,
  wrapperClassName,
  selectedFrameId,
  aspectRatio,
  selectedTab,
  overrideImageUrl,
  overrideVideoUrl,
  badgeMessage,
  modelMismatchLabel,
  progressMessage,
  retry,
  posterUrl,
  onTimeUpdate,
  onEnded,
}) => {
  const [shouldAutoPlay, setShouldAutoPlay] = useState(false);

  const imageDimensions = aspectRatioToDimensions(aspectRatio);
  // Get current frame and next frame
  const [currentFrameIndex, setCurrentFrameIndex] = useState(
    frames?.findIndex((frame) => frame.id === selectedFrameId) ?? -1
  );
  useEffect(() => {
    // We could use a useMemo here, but we want to support not having to have a callback to set the selected frame id
    setCurrentFrameIndex(
      frames?.findIndex((frame) => frame.id === selectedFrameId) ?? -1
    );
  }, [selectedFrameId, frames]);

  const currentFrame =
    frames && currentFrameIndex >= 0 ? frames[currentFrameIndex] : undefined;
  const nextFrame =
    frames && currentFrameIndex < frames.length - 1
      ? frames.find(
          (frame, index) =>
            frame.videoStatus === 'completed' &&
            frame.videoUrl &&
            index > currentFrameIndex,
          currentFrameIndex + 1
        )
      : undefined;

  const handleCopyImageUrl = useCallback(async () => {
    if (!currentFrame?.thumbnailUrl) return;
    try {
      // Stored media URLs are origin-relative (#894) — absolutize against the
      // current origin so the copied link is usable when pasted elsewhere. The
      // worker's public /r2 route serves it (redirecting to the CDN in prod).
      const absoluteUrl = new URL(
        currentFrame.thumbnailUrl,
        window.location.origin
      ).href;
      await navigator.clipboard.writeText(absoluteUrl);
      toast.success('Image URL copied');
    } catch {
      toast.error('Failed to copy URL');
    }
  }, [currentFrame?.thumbnailUrl]);

  const handleCopyVideoUrl = useCallback(async () => {
    if (!currentFrame?.videoUrl) return;
    try {
      const absoluteUrl = new URL(currentFrame.videoUrl, window.location.origin)
        .href;
      await navigator.clipboard.writeText(absoluteUrl);
      toast.success('Video URL copied');
    } catch {
      toast.error('Failed to copy URL');
    }
  }, [currentFrame?.videoUrl]);

  // Check video status
  const hasCompletedVideo =
    currentFrame &&
    currentFrame.videoStatus === 'completed' &&
    currentFrame.videoUrl;
  const hasFailedVideo = currentFrame && currentFrame.videoStatus === 'failed';

  // Fetch signed download URL with Content-Disposition header (forces browser download)
  const { data: downloadData } = useFrameDownloadUrl(
    { frameId: currentFrame?.id, sequenceId: currentFrame?.sequenceId },
    !!hasCompletedVideo
  );

  const handleDownloadVideo = useCallback(() => {
    if (!downloadData?.downloadUrl) return;
    const a = document.createElement('a');
    a.href = downloadData.downloadUrl;
    a.download =
      downloadData.filename ||
      `scene-${currentFrame?.id ?? 'unknown'}_openstory.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }, [downloadData, currentFrame?.id]);

  // Handle video pause - disable autoplay when user manually pauses
  const handlePause = useCallback(() => {
    setShouldAutoPlay(false);
  }, []);

  // Video end: stop on the current scene. We intentionally do NOT auto-advance
  // to the next scene — single-scene review shouldn't roll into the next clip.
  // Continuous playback of the whole sequence lives in Theatre.
  const handleEnded = useCallback(() => {
    setShouldAutoPlay(false);
    onEnded?.();
  }, [onEnded]);

  // Show blob loader during generation, skeleton otherwise
  if (!frames || frames.length === 0) {
    if (progressMessage) {
      return (
        <div className={cn('flex w-full flex-col', wrapperClassName)}>
          <div
            className={cn(
              'relative flex w-full items-center justify-center overflow-hidden bg-muted',
              className,
              getAspectRatioClassName(aspectRatio)
            )}
          >
            {posterUrl ? (
              <>
                <AppImage
                  src={posterUrl}
                  alt=""
                  width={imageDimensions.width}
                  height={imageDimensions.height}
                  className="absolute inset-0 h-full w-full object-cover"
                />
                <span className="absolute top-2 right-2 z-10 rounded bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
                  Preview
                </span>
              </>
            ) : (
              <>
                <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_50%,rgba(167,112,239,0.12),transparent_70%)]" />
                <div className="relative flex flex-col items-center gap-4">
                  <BlobLoader size="lg" />
                  <div className="flex items-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                    <p className="text-sm font-medium">{progressMessage}</p>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      );
    }
    if (posterUrl) {
      return (
        <div className={cn('flex w-full flex-col', wrapperClassName)}>
          <div
            className={cn(
              'relative overflow-hidden',
              className,
              getAspectRatioClassName(aspectRatio)
            )}
          >
            <AppImage
              src={posterUrl}
              alt=""
              width={imageDimensions.width}
              height={imageDimensions.height}
              className="h-full w-full object-cover"
            />
            <span className="absolute top-2 right-2 z-10 rounded bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
              Preview
            </span>
          </div>
        </div>
      );
    }
    return (
      <div className={cn('flex w-full flex-col', wrapperClassName)}>
        <div className={cn(className, getAspectRatioClassName(aspectRatio))}>
          <Skeleton className="w-full h-full" />
        </div>
      </div>
    );
  }

  if (!currentFrame) {
    return (
      <EmptyState
        icon={<VideoIcon />}
        title={'No selected frame'}
        description={'Please select a frame to play.'}
      />
    );
  }

  // Get scene title for alt text — match scene-list-item fallback
  const sceneNumber =
    currentFrame.metadata?.sceneNumber ??
    (currentFrameIndex >= 0 ? currentFrameIndex + 1 : undefined);
  const title =
    currentFrame.metadata?.metadata?.title ??
    (sceneNumber ? `Scene ${sceneNumber}` : undefined);

  // Best available image: override (variant preview) → final thumbnail → fast preview → sequence poster
  const displayImage =
    overrideImageUrl ??
    currentFrame.thumbnailUrl ??
    currentFrame.previewThumbnailUrl ??
    posterUrl ??
    null;
  const isPreviewImage =
    !!currentFrame.previewThumbnailUrl && !currentFrame.thumbnailUrl;
  const isVariantPreview =
    !!overrideImageUrl && overrideImageUrl !== currentFrame.thumbnailUrl;

  // The image-focused tabs (the still image + the shot-variant grid) keep
  // showing the image; every other tab (script, motion, cast, location,
  // elements) shows the scene's video when one exists.
  const showsStillImage =
    selectedTab === 'image-prompt' || selectedTab === 'scene-variants';

  // Per-scene video-variant preview (#545): on the motion tab, play the
  // override variant for this frame instead of its primary video.
  const isVariantVideoPreview =
    !!overrideVideoUrl &&
    !showsStillImage &&
    overrideVideoUrl !== currentFrame.videoUrl;
  const playbackVideoUrl = showsStillImage
    ? ''
    : (overrideVideoUrl ?? currentFrame.videoUrl ?? '');

  return (
    <div className={cn('flex w-full flex-col', wrapperClassName)}>
      {hasFailedVideo ? (
        <div
          className={cn(
            'relative overflow-hidden',
            getAspectRatioClassName(aspectRatio),
            // Use bg-muted as fallback when no image at all
            !displayImage && 'bg-muted',
            className
          )}
        >
          {/* Show best available image as background */}
          {displayImage && (
            <a
              href={currentFrame.thumbnailUrl ?? displayImage}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full h-full"
            >
              <AppImage
                src={displayImage}
                alt={title || 'Scene thumbnail'}
                className="w-full h-full object-cover"
                width={imageDimensions.width}
                height={imageDimensions.height}
              />
            </a>
          )}

          {/* Share dropdown */}
          {currentFrame.thumbnailUrl && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-2 right-2 z-10 h-8 w-8 bg-black/50 text-white hover:bg-black/70"
                  aria-label="Share image"
                >
                  <Share2 className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => void handleCopyImageUrl()}>
                  <Link className="h-4 w-4" />
                  Copy scene image URL
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {/* Error overlay */}
          <div
            className={cn(
              'absolute inset-0 flex items-center justify-center pointer-events-none',
              // Use semi-transparent overlay if image exists, solid bg if not
              displayImage ? 'bg-muted/80' : 'bg-transparent'
            )}
          >
            <div className="flex flex-col items-center gap-2 text-muted-foreground">
              <AlertCircle className="h-8 w-8" />
              <span className="text-sm">Failed to generate video</span>
            </div>
          </div>
        </div>
      ) : (
        <div
          className={cn(
            'relative w-full',
            getAspectRatioClassName(aspectRatio),
            className
          )}
        >
          {/* Share dropdown */}
          {(currentFrame.thumbnailUrl || currentFrame.videoUrl) && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-2 right-2 z-10 h-8 w-8 bg-black/50 text-white hover:bg-black/70"
                  aria-label="Share"
                >
                  <Share2 className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {currentFrame.thumbnailUrl && (
                  <DropdownMenuItem onClick={() => void handleCopyImageUrl()}>
                    <Link className="h-4 w-4" />
                    Copy scene image URL
                  </DropdownMenuItem>
                )}
                {currentFrame.videoUrl && (
                  <DropdownMenuItem onClick={() => void handleCopyVideoUrl()}>
                    <VideoIcon className="h-4 w-4" />
                    Copy scene video URL
                  </DropdownMenuItem>
                )}
                {hasCompletedVideo && downloadData?.downloadUrl && (
                  <DropdownMenuItem onClick={handleDownloadVideo}>
                    <Download className="h-4 w-4" />
                    Download scene video
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {/* Clickable overlay to open the displayed image in a new tab — only
              when the poster (image) is what's showing, i.e. there's no
              playable video. Keyed off `playbackVideoUrl` (and href = the
              image actually displayed) so it never covers the video's play
              button or opens a different image than the poster. */}
          {displayImage && !playbackVideoUrl && (
            <a
              href={displayImage}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute inset-0 z-[5] cursor-pointer"
              aria-label="Open image in new tab"
            />
          )}
          <VideoPlayer
            key={playbackVideoUrl} // Force re-render when video changes
            src={playbackVideoUrl}
            posterSrc={displayImage}
            aspectRatio={aspectRatio}
            className="w-full"
            autoPlay={shouldAutoPlay}
            onTimeUpdate={onTimeUpdate}
            onPause={handlePause}
            onEnded={handleEnded}
          />
          {/* Show overlay for image/video generation states */}
          <VideoStateOverlay
            thumbnailUrl={displayImage}
            videoStatus={
              isVariantVideoPreview
                ? 'completed'
                : (currentFrame.videoStatus ?? null)
            }
            progressMessage={progressMessage}
            retry={retry}
          />
          {badgeMessage && (
            <span className="absolute top-2 left-2 z-10 rounded bg-primary/80 px-2 py-1 text-xs font-medium text-primary-foreground backdrop-blur-sm">
              {badgeMessage}
            </span>
          )}
          {modelMismatchLabel && !badgeMessage && (
            <span className="absolute top-2 left-2 z-10 rounded bg-amber-500/90 px-2 py-1 text-xs font-medium text-white backdrop-blur-sm">
              {modelMismatchLabel}
            </span>
          )}
          {isPreviewImage && !isVariantPreview && (
            <span className="absolute top-2 right-2 z-10 rounded bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
              Preview
            </span>
          )}
        </div>
      )}
      <p
        className={cn(
          'text-xs italic py-1 transition-opacity duration-300',
          isPreviewImage
            ? 'text-muted-foreground opacity-100'
            : 'opacity-0 select-none'
        )}
        aria-hidden={!isPreviewImage}
      >
        Fast preview — may not match the final image.
      </p>
      {/* Preload next video in background if it's completed */}
      {nextFrame?.videoUrl && nextFrame.videoStatus === 'completed' && (
        <div className="hidden">
          {/* eslint-disable-next-line jsx-a11y/media-has-caption -- preload only, not user-facing */}
          <video
            key={nextFrame.videoUrl}
            src={nextFrame.videoUrl}
            preload="auto"
          />
        </div>
      )}
    </div>
  );
};
