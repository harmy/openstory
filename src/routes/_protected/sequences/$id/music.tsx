import { MusicView, MusicViewSkeleton } from '@/components/music/music-view';
import { generateMusicFn, mergeVideoAndMusicFn } from '@/functions/sequences';
import { useFramesBySequence } from '@/hooks/use-frames';
import { useSequence, sequenceKeys } from '@/hooks/use-sequences';
import { useGenerationStream } from '@/lib/realtime/use-generation-stream';
import { usePostHog } from '@posthog/react';
import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
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
    mutationFn: () => mergeVideoAndMusicFn({ data: { sequenceId } }),
    onMutate: () => {
      queryClient.setQueryData<Sequence>(
        sequenceKeys.detail(sequenceId),
        (old) => (old ? { ...old, mergedVideoStatus: 'merging' as const } : old)
      );
      posthog.capture('merged_video_generation_started', {
        sequence_id: sequenceId,
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
          onMergeVideoAndMusic={() => mergeVideoAndMusic.mutate()}
          isMergingVideoAndMusic={mergeVideoAndMusic.isPending}
        />
      </div>
    </div>
  );
}
