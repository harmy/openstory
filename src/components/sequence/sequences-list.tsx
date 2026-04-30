import { AspectRatioIcon } from '@/components/icons/aspect-ratio-icon';
import { ModelBadge } from '@/components/model/model-badge';
import { SequenceStatusBadge } from '@/components/sequence/sequence-status-badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useSequences } from '@/hooks/use-sequences';
import { getAspectRatioData } from '@/lib/constants/aspect-ratios';
import { formatDistanceToNow } from '@/lib/format-date';
import { formatDuration } from '@/lib/utils/format-duration';
import { Route as sequencesScenesRoute } from '@/routes/_protected/sequences/$id/scenes';
import { Calendar, Clock, Timer, VideoIcon } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import type React from 'react';

interface SequencesListProps {
  teamId?: string;
}

export const SequencesList: React.FC<SequencesListProps> = ({ teamId }) => {
  const { data: sequences, isLoading, error } = useSequences(teamId);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {[1, 2, 3].map((n) => (
          <Card key={`skeleton-${n}`} className="p-6 animate-pulse">
            <div className="h-4 bg-muted rounded w-3/4 mb-4" />
            <div className="h-3 bg-muted rounded w-1/2 mb-2" />
            <div className="h-3 bg-muted rounded w-2/3" />
          </Card>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <Card className="p-8 text-center">
        <p className="text-destructive mb-4">Failed to load sequences</p>
        <Button variant="outline" onClick={() => window.location.reload()}>
          Try Again
        </Button>
      </Card>
    );
  }

  if (!sequences || sequences.length === 0) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {sequences.map((sequence) => {
        const ratioData = getAspectRatioData(sequence.aspectRatio);

        return (
          <Link
            key={sequence.id}
            to={sequencesScenesRoute.fullPath}
            params={{ id: sequence.id }}
          >
            <Card className="p-6 hover:shadow-lg transition-shadow cursor-pointer h-full">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <VideoIcon className="h-5 w-5 text-primary" />

                    <h3 className="font-semibold text-lg line-clamp-1">
                      {sequence.title || 'Untitled Sequence'}
                    </h3>
                  </div>
                  <div className="flex items-center gap-2">
                    <ModelBadge model={sequence.analysisModel} />
                    <SequenceStatusBadge status={sequence.status} />
                  </div>
                </div>
              </div>

              {sequence.script && (
                <p className="text-sm text-muted-foreground mb-4 line-clamp-3">
                  {sequence.script}
                </p>
              )}

              <div className="flex items-center gap-4 text-xs text-muted-foreground">
                <div className="flex items-center gap-1">
                  <Calendar className="h-3 w-3" />
                  <span>
                    {formatDistanceToNow(new Date(sequence.createdAt))}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  <span>
                    {formatDistanceToNow(new Date(sequence.updatedAt))}
                  </span>
                </div>
                {sequence.analysisDurationMs > 0 && (
                  <div className="flex items-center gap-1">
                    <Timer className="h-3 w-3" />
                    <span>{formatDuration(sequence.analysisDurationMs)}</span>
                  </div>
                )}
                {ratioData && (
                  <div className="flex items-center gap-1">
                    <AspectRatioIcon
                      width={ratioData.width}
                      height={ratioData.height}
                      size="sm"
                    />
                    <span>{ratioData.label}</span>
                  </div>
                )}
              </div>
            </Card>
          </Link>
        );
      })}
    </div>
  );
};
