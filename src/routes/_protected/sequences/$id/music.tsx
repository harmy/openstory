import { MusicView, MusicViewSkeleton } from '@/components/music/music-view';
import { SequenceVariantCompareDialog } from '@/components/sequence/sequence-variant-compare-dialog';
import { DivergentAlternateBanner } from '@/components/staleness/divergent-alternate-banner';
import {
  getMusicPromptStalenessFn,
  regenerateMusicPromptFn,
} from '@/functions/prompt-variants';
import { generateMusicFn, mergeVideoAndMusicFn } from '@/functions/sequences';
import { useFramesBySequence } from '@/hooks/use-frames';
import { useSequence, sequenceKeys } from '@/hooks/use-sequences';
import {
  useDiscardSequenceMusicVariant,
  usePromoteSequenceMusicVariant,
  useSequenceDivergentMusicVariants,
  useUndiscardSequenceMusicVariant,
} from '@/hooks/use-sequence-variants';
import type { SequenceMusicVariant } from '@/lib/db/schema';
import { useGenerationStream } from '@/lib/realtime/use-generation-stream';
import { useSequenceStaleDetected } from '@/lib/realtime/use-sequence-stale-detected';
import { usePostHog } from '@posthog/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { toast } from 'sonner';
import type { Sequence } from '@/types/database';

export const Route = createFileRoute('/_protected/sequences/$id/music')({
  component: MusicPage,
  staticData: { breadcrumb: 'Music' },
});

function MusicPage() {
  const { id: sequenceId } = Route.useParams();

  const { data: sequence, isLoading } = useSequence(sequenceId, {
    refetchInterval: (query) => {
      if (query.state.data?.mergedVideoStatus === 'merging') return 2000;
      return false;
    },
  });
  const { data: frames } = useFramesBySequence(sequenceId, {
    refetchInterval: false,
  });
  const queryClient = useQueryClient();
  const posthog = usePostHog();

  // Compute total video duration from frames (same logic as generateMusicFn)
  const videoDuration = useMemo(() => {
    if (!frames?.length) return undefined;
    return frames.reduce((sum, frame) => {
      const seconds = frame.durationMs
        ? frame.durationMs / 1000
        : (frame.metadata?.metadata?.durationSeconds ?? 10);
      return sum + seconds;
    }, 0);
  }, [frames]);

  // Subscribe to realtime events (audio:progress updates sequence cache)
  useGenerationStream(sequenceId);

  useSequenceStaleDetected(sequenceId);

  const generating = sequence?.musicStatus === 'generating';
  const { data: divergentMusicVariants } = useSequenceDivergentMusicVariants(
    sequenceId,
    generating ? { refetchInterval: 2000 } : undefined
  );

  const promoteVariant = usePromoteSequenceMusicVariant();
  const discardVariant = useDiscardSequenceMusicVariant();
  const undiscardVariant = useUndiscardSequenceMusicVariant();

  const [compareVariant, setCompareVariant] =
    useState<SequenceMusicVariant | null>(null);

  useEffect(() => {
    if (!compareVariant || !divergentMusicVariants) return;
    const stillExists = divergentMusicVariants.some(
      (v) => v.id === compareVariant.id
    );
    if (!stillExists) setCompareVariant(null);
  }, [compareVariant, divergentMusicVariants]);

  const handleDiscardWithUndo = useCallback(
    (variant: SequenceMusicVariant) => {
      const restore = () => {
        undiscardVariant.mutate(
          { sequenceId, variantId: variant.id },
          {
            onError: (error) => {
              toast.error('Failed to restore alternate', {
                description:
                  error instanceof Error ? error.message : 'Unknown error',
              });
            },
          }
        );
      };
      discardVariant.mutate(
        { sequenceId, variantId: variant.id },
        {
          onSuccess: () => {
            setCompareVariant(null);
            toast('Alternate discarded', {
              action: { label: 'Undo', onClick: restore },
            });
          },
          onError: (error) => {
            toast.error('Failed to discard alternate', {
              description:
                error instanceof Error ? error.message : 'Unknown error',
            });
          },
        }
      );
    },
    [sequenceId, discardVariant, undiscardVariant]
  );

  const handlePromote = useCallback(
    (variant: SequenceMusicVariant) => {
      promoteVariant.mutate(
        { sequenceId, variantId: variant.id },
        {
          onSuccess: () => {
            setCompareVariant(null);
            toast.success('Alternate promoted');
          },
          onError: (error) => {
            toast.error('Failed to promote alternate', {
              description:
                error instanceof Error ? error.message : 'Unknown error',
            });
          },
        }
      );
    },
    [sequenceId, promoteVariant]
  );

  const generateMusic = useMutation({
    mutationFn: (args?: {
      prompt?: string;
      tags?: string;
      model?: string;
      duration?: number;
    }) =>
      generateMusicFn({
        data: {
          sequenceId,
          prompt: args?.prompt,
          tags: args?.tags,
          model: args?.model,
          duration: args?.duration,
        },
      }),
    onMutate: (args) => {
      queryClient.setQueryData<Sequence>(
        sequenceKeys.detail(sequenceId),
        (old) => (old ? { ...old, musicStatus: 'generating' as const } : old)
      );
      posthog.capture('music_generation_started', {
        sequence_id: sequenceId,
        has_custom_prompt: !!args?.prompt,
        duration: args?.duration,
      });
    },
  });

  const mergeVideoAndMusic = useMutation({
    mutationFn: (args: { includeMusic: boolean }) =>
      mergeVideoAndMusicFn({
        data: { sequenceId, includeMusic: args.includeMusic },
      }),
    onMutate: (args) => {
      queryClient.setQueryData<Sequence>(
        sequenceKeys.detail(sequenceId),
        (old) => (old ? { ...old, mergedVideoStatus: 'merging' as const } : old)
      );
      posthog.capture('merged_video_generation_started', {
        sequence_id: sequenceId,
        include_music: args.includeMusic,
      });
    },
  });

  const latestDivergent = divergentMusicVariants?.[0];

  const divergentBanner = latestDivergent ? (
    <DivergentAlternateBanner
      variantId={latestDivergent.id}
      artifact="music"
      entityType="sequence"
      onCompare={() => setCompareVariant(latestDivergent)}
      onPromote={() => handlePromote(latestDivergent)}
      onDiscard={() => handleDiscardWithUndo(latestDivergent)}
    />
  ) : null;

  const musicPromptStalenessKey = [
    'music-prompt-staleness',
    sequenceId,
  ] as const;
  const { data: musicPromptStaleness } = useQuery({
    queryKey: musicPromptStalenessKey,
    queryFn: () => getMusicPromptStalenessFn({ data: { sequenceId } }),
    staleTime: 30_000,
  });

  const regenerateMusicPrompt = useMutation({
    mutationFn: () => regenerateMusicPromptFn({ data: { sequenceId } }),
    onSuccess: async (result) => {
      if (result.alreadyUpToDate) {
        toast.info('Music prompt is already up to date');
      }
      await queryClient.invalidateQueries({
        queryKey: musicPromptStalenessKey,
      });
      await queryClient.invalidateQueries({
        queryKey: sequenceKeys.detail(sequenceId),
      });
    },
    onError: (error) => {
      toast.error('Music prompt regenerate failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

  if (isLoading || !sequence) {
    return (
      <div className="flex-1 p-4">
        <div className="max-w-4xl mx-auto">
          <MusicViewSkeleton />
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="max-w-4xl mx-auto">
        <MusicView
          sequence={sequence}
          videoDuration={videoDuration}
          onGenerateMusic={(args) => generateMusic.mutate(args)}
          isGeneratingMusic={generateMusic.isPending}
          onMergeVideoAndMusic={(args) => mergeVideoAndMusic.mutate(args)}
          isMergingVideoAndMusic={mergeVideoAndMusic.isPending}
          divergentBanner={divergentBanner}
          isMusicPromptStale={musicPromptStaleness?.musicPrompt === 'stale'}
          onRegenerateMusicPrompt={() => regenerateMusicPrompt.mutate()}
          isRegeneratingMusicPrompt={regenerateMusicPrompt.isPending}
        />
      </div>
      {compareVariant && (
        <SequenceVariantCompareDialog
          kind="music"
          open={true}
          onOpenChange={(open) => {
            if (!open) setCompareVariant(null);
          }}
          sequence={sequence}
          variant={compareVariant}
          onPromote={() => handlePromote(compareVariant)}
          onDiscard={() => handleDiscardWithUndo(compareVariant)}
          isPromoting={promoteVariant.isPending}
          isDiscarding={discardVariant.isPending}
        />
      )}
    </div>
  );
}
