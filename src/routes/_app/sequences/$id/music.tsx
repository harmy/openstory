import { MusicView, MusicViewSkeleton } from '@/components/music/music-view';
import { DivergentAlternateBanner } from '@/components/staleness/divergent-alternate-banner';
import {
  getMusicPromptStalenessFn,
  regenerateMusicPromptFn,
} from '@/functions/prompt-variants';
import { generateMusicFn } from '@/functions/sequences';
import { useActiveAudioModel } from '@/hooks/use-active-audio-model';
import { useShotsBySequence } from '@/hooks/use-shots';
import {
  useSequence,
  useSequenceAudioVariants,
  useSetSequenceMusic,
  sequenceKeys,
} from '@/hooks/use-sequences';
import {
  useDiscardSequenceMusicVariant,
  usePromoteSequenceMusicVariant,
  useSequenceDivergentMusicVariants,
  useSetMusicFromVariant,
  useUndiscardSequenceMusicVariant,
} from '@/hooks/use-sequence-variants';
import { type ModelGenerationStatus } from '@/components/model/base-model-selector';
import {
  DEFAULT_MUSIC_MODEL,
  safeAudioModel,
  type AudioModel,
} from '@/lib/ai/models';
import type { SequenceMusicVariant } from '@/lib/db/schema';
import { useGenerationStream } from '@/lib/realtime/use-generation-stream';
import { useSequenceStaleDetected } from '@/lib/realtime/use-sequence-stale-detected';
import { usePostHog } from '@posthog/react';
import { useCallback, useMemo } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { toast } from 'sonner';
import type { Sequence } from '@/types/database';

export const Route = createFileRoute('/_app/sequences/$id/music')({
  component: MusicPage,
  staticData: { breadcrumb: 'Music' },
});

function MusicPage() {
  const { id: sequenceId } = Route.useParams();

  const { data: sequence, isLoading } = useSequence(sequenceId);
  const { data: frames } = useShotsBySequence(sequenceId, {
    refetchInterval: false,
  });
  // Resolve the music tab through the viewer's active audio model (#546). When
  // a model is pinned in the header, play that model's track instead of the
  // live `sequences.music*` primary; unpinned (null) follows the primary.
  const { activeAudioModel, selectAudioModel } =
    useActiveAudioModel(sequenceId);
  const { data: audioVariants } = useSequenceAudioVariants(sequenceId);
  const resolvedSequence = useMemo<Sequence | undefined>(() => {
    if (!sequence || !activeAudioModel || !audioVariants) return sequence;
    // Player-only remap (mirrors scenes-view's playerFrames): swap ONLY the
    // playback URL to the pinned model's completed track. Status / error /
    // prompt / tags stay sourced from the live sequence so a regeneration of
    // the pinned model still surfaces the generating spinner + failure UI and
    // never clobbers an in-progress prompt edit. Only swap while the live track
    // is completed — never mask a live generating/failed state.
    if (sequence.musicStatus !== 'completed') return sequence;
    const variant = audioVariants.find(
      (v) =>
        v.model === activeAudioModel &&
        v.divergedAt === null &&
        v.discardedAt === null &&
        v.status === 'completed' &&
        v.url
    );
    if (!variant?.url) return sequence;
    return { ...sequence, musicUrl: variant.url };
  }, [sequence, activeAudioModel, audioVariants]);

  // Per-model status for the music model selector + action button (#546),
  // mirroring scenes-view's videoModelStatuses. The "set" model is the one
  // whose track is the sequence's live primary (url match, else the recorded
  // musicModel); a completed alternate is selectable, then promoted via "Set
  // Music". Music variant rows have no 'generating' state, so the live
  // generating status is overlaid onto the model currently being generated.
  const audioModelStatuses = useMemo(() => {
    const map = new Map<string, ModelGenerationStatus>();
    const variants = (audioVariants ?? []).filter(
      (v) => v.divergedAt === null && v.discardedAt === null
    );
    const primaryUrl = sequence?.musicUrl ?? null;
    const setModel = primaryUrl
      ? (variants.find((v) => v.url === primaryUrl)?.model ??
        sequence?.musicModel ??
        null)
      : null;
    for (const v of variants) {
      map.set(v.model, v.model === setModel ? 'set' : v.status);
    }
    if (setModel && !map.has(setModel)) map.set(setModel, 'set');
    if (sequence?.musicStatus === 'generating' && sequence.musicModel) {
      map.set(sequence.musicModel, 'generating');
    }
    return map;
  }, [
    audioVariants,
    sequence?.musicUrl,
    sequence?.musicModel,
    sequence?.musicStatus,
  ]);

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

  const setMusicEnabled = useSetSequenceMusic(sequenceId);

  const promoteVariant = usePromoteSequenceMusicVariant();
  const discardVariant = useDiscardSequenceMusicVariant();
  const undiscardVariant = useUndiscardSequenceMusicVariant();
  const setMusicModel = useSetMusicFromVariant();

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

  // "Set Music": switch the sequence's live primary to the selected model's
  // track (mirrors the video tab's "Set Video"). Non-destructive — the server
  // resolves the model to its live completed variant and keeps the row.
  const handleSetModel = useCallback(
    (model: AudioModel) => {
      setMusicModel.mutate(
        { sequenceId, model },
        {
          onSuccess: () => {
            toast.success('Music model set');
          },
          onError: (error) => {
            toast.error('Failed to set music model', {
              description:
                error instanceof Error ? error.message : 'Unknown error',
            });
          },
        }
      );
    },
    [sequenceId, setMusicModel]
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

  const latestDivergent = divergentMusicVariants?.[0];

  const divergentBanner = latestDivergent ? (
    <DivergentAlternateBanner
      variantId={latestDivergent.id}
      artifact="music"
      entityType="sequence"
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

  // The music-tab model selector is controlled by the viewer's active audio
  // model (#546) so it stays in sync with the sequence-header dropdown — both
  // read/write the same useActiveAudioModel store. Null (no pin) follows the
  // live primary; picking the primary clears the pin.
  const primaryAudioModel = safeAudioModel(
    sequence?.musicModel,
    DEFAULT_MUSIC_MODEL
  );
  const selectedAudioModel = activeAudioModel ?? primaryAudioModel;
  const handleSelectModel = useCallback(
    (model: AudioModel) => {
      selectAudioModel(model === primaryAudioModel ? null : model);
    },
    [selectAudioModel, primaryAudioModel]
  );

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
          sequence={resolvedSequence ?? sequence}
          videoDuration={videoDuration}
          audioModelStatuses={audioModelStatuses}
          selectedModel={selectedAudioModel}
          onModelChange={handleSelectModel}
          onSetModel={handleSetModel}
          isSettingModel={setMusicModel.isPending}
          onGenerateMusic={(args) => generateMusic.mutate(args)}
          isGeneratingMusic={generateMusic.isPending}
          divergentBanner={divergentBanner}
          isMusicPromptStale={musicPromptStaleness?.musicPrompt === 'stale'}
          onRegenerateMusicPrompt={() => regenerateMusicPrompt.mutate()}
          isRegeneratingMusicPrompt={regenerateMusicPrompt.isPending}
          onIncludeMusicChange={(includeMusic) =>
            setMusicEnabled.mutate(includeMusic)
          }
        />
      </div>
    </div>
  );
}
