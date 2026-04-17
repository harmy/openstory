/**
 * Theatre View
 * Displays the merged video for a sequence
 */

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { VideoPlayer } from '@/components/motion/video-player';
import type { Sequence } from '@/types/database';
import {
  Loader2,
  AlertCircle,
  Film,
  Share2,
  Link,
  Download,
} from 'lucide-react';
import { usePostHog } from '@posthog/react';
import { useCallback } from 'react';
import { toast } from 'sonner';

type TheatreViewProps = {
  sequence: Sequence;
  onGenerateMergedVideo?: () => void;
  isGenerating?: boolean;
};

export const TheatreView: React.FC<TheatreViewProps> = ({
  sequence,
  onGenerateMergedVideo,
  isGenerating = false,
}) => {
  const { mergedVideoStatus, mergedVideoUrl, mergedVideoError, aspectRatio } =
    sequence;
  const posthog = usePostHog();

  const handleCopyVideoUrl = useCallback(async () => {
    if (!mergedVideoUrl) return;
    try {
      await navigator.clipboard.writeText(mergedVideoUrl);
      toast.success('Video URL copied');
      posthog.capture('video_url_copied', {
        sequence_id: sequence.id,
      });
    } catch (err) {
      toast.error('Failed to copy URL');
      posthog.captureException(err);
    }
  }, [mergedVideoUrl, sequence.id, posthog]);

  const handleDownloadVideo = useCallback(() => {
    if (!mergedVideoUrl) return;
    const a = document.createElement('a');
    a.href = mergedVideoUrl;
    a.download = `${sequence.title || 'sequence'}_openstory.mp4`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    posthog.capture('video_downloaded', {
      sequence_id: sequence.id,
    });
  }, [mergedVideoUrl, sequence.id, sequence.title, posthog]);

  // Merging state
  if (mergedVideoStatus === 'merging') {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        <p className="text-muted-foreground">Merging video segments…</p>
      </div>
    );
  }

  // Completed state - show video
  if (mergedVideoStatus === 'completed' && mergedVideoUrl) {
    return (
      <div className="relative">
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
            <DropdownMenuItem onClick={() => void handleCopyVideoUrl()}>
              <Link className="h-4 w-4" />
              Copy video URL
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleDownloadVideo}>
              <Download className="h-4 w-4" />
              Download video
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <VideoPlayer src={mergedVideoUrl} aspectRatio={aspectRatio} />
      </div>
    );
  }

  // Failed state
  if (mergedVideoStatus === 'failed') {
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16">
        <AlertCircle className="h-8 w-8 text-destructive" />
        <p className="text-destructive">Failed to merge video</p>
        {mergedVideoError && (
          <p className="text-sm text-muted-foreground max-w-md text-center">
            {mergedVideoError}
          </p>
        )}
        {onGenerateMergedVideo && (
          <Button onClick={onGenerateMergedVideo} disabled={isGenerating}>
            {isGenerating ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Retrying…
              </>
            ) : (
              'Retry Merge'
            )}
          </Button>
        )}
      </div>
    );
  }

  // Pending state - no merged video yet
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-16">
      <Film className="h-8 w-8 text-muted-foreground" />
      <p className="text-muted-foreground">No merged video yet</p>
      <p className="text-sm text-muted-foreground max-w-md text-center">
        The merged video will be generated automatically once all motion
        segments are complete.
      </p>
      {onGenerateMergedVideo && (
        <Button
          variant="outline"
          onClick={onGenerateMergedVideo}
          disabled={isGenerating}
        >
          {isGenerating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Generating…
            </>
          ) : (
            'Generate Now'
          )}
        </Button>
      )}
    </div>
  );
};

export const TheatreViewSkeleton: React.FC = () => (
  <Skeleton className="aspect-video w-full" />
);
