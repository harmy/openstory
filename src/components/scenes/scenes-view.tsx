import { GenerationProgressBanner } from '@/components/generation/generation-progress-banner';
import { MotionProgressBanner } from '@/components/generation/motion-progress-banner';
import { ScenePlayer } from '@/components/motion/scene-player';
import { MobileSceneDrawer } from '@/components/scenes/mobile-scene-drawer';
import { SceneList } from '@/components/scenes/scene-list';
import type { BatchGenerateMotionArgs } from '@/components/scenes/scene-list';
import {
  SceneScriptPrompts,
  type TabValue,
} from '@/components/scenes/scene-script-prompts';
import { FailureSummaryBanner } from '@/components/sequence/failure-summary-banner';
import { ScrollArea } from '@/components/ui/scroll-area';
import { batchGenerateMotionFn } from '@/functions/motion-functions';
import { smartRetryFn } from '@/functions/smart-retry';
import { BILLING_BALANCE_KEY } from '@/hooks/use-billing-balance';
import {
  frameKeys,
  useDiscardVariant,
  useDivergentVariants,
  useFramesBySequence,
  usePromoteVariantToPrimary,
  useUndiscardVariant,
} from '@/hooks/use-frames';
import { useStaleDetected } from '@/lib/realtime/use-stale-detected';
import { DivergenceCompareDialog } from '@/components/scenes/divergence-compare-dialog';
import { getDivergentVariantPromptDiffFn } from '@/functions/prompt-variants';
import { sequenceKeys, useSequence } from '@/hooks/use-sequences';
import { useStyle } from '@/hooks/use-styles';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  DEFAULT_ASPECT_RATIO,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import { analyzeFailures } from '@/lib/failures/failure-analysis';
import type { GenerationPhaseConfig } from '@/lib/realtime/generation-stream.reducer';
import { useGenerationStream } from '@/lib/realtime/use-generation-stream';
import { getSequenceImageVariantsFn } from '@/functions/frames';
import type { Frame, FrameVariant } from '@/lib/db/schema';
import type { Sequence } from '@/types/database';
import { usePostHog } from '@posthog/react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';

type ScenesViewProps = {
  sequenceId: string;
};

const CompareWithPromptDiff: React.FC<{
  sequenceId: string;
  frame: Frame;
  variant: FrameVariant;
  onClose: () => void;
  onPromote: () => void;
  onDiscard: () => void;
  isPromoting: boolean;
  isDiscarding: boolean;
}> = ({
  sequenceId,
  frame,
  variant,
  onClose,
  onPromote,
  onDiscard,
  isPromoting,
  isDiscarding,
}) => {
  const { data: promptDiff } = useQuery({
    queryKey: ['variant-prompt-diff', sequenceId, variant.id],
    queryFn: () =>
      getDivergentVariantPromptDiffFn({
        data: { sequenceId, variantId: variant.id },
      }),
    staleTime: 30_000,
  });
  return (
    <DivergenceCompareDialog
      open={true}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      frame={frame}
      variant={variant}
      onPromote={onPromote}
      onDiscard={onDiscard}
      isPromoting={isPromoting}
      isDiscarding={isDiscarding}
      promptDiff={promptDiff ?? undefined}
    />
  );
};

// Full class names required for Tailwind JIT to detect at build time
// Split into max-width (for the wrapper, enables centering) and max-height (for the player div)
const PLAYER_MAX_W_BY_RATIO: Record<AspectRatio, string> = {
  '16:9': 'max-w-[calc(50vh*1.7777777777777777)]',
  '9:16': 'max-w-[calc(50vh*0.5625)]',
  '1:1': 'max-w-[50vh]',
};
const PLAYER_MAX_H = 'max-h-[50vh]';

type RegenerationType = 'image' | 'motion' | 'scene-variants';

function addToSet(prev: Set<string>, id: string): Set<string> {
  return new Set(prev).add(id);
}

function removeFromSet(prev: Set<string>, id: string): Set<string> {
  const next = new Set(prev);
  next.delete(id);
  return next;
}

function addAllToSet(prev: Set<string>, ids: string[]): Set<string> {
  const next = new Set(prev);
  for (const id of ids) next.add(id);
  return next;
}

function removeAllFromSet(prev: Set<string>, ids: string[]): Set<string> {
  const next = new Set(prev);
  for (const id of ids) next.delete(id);
  return next;
}

function isTerminalStatus(status: string | null): boolean {
  return status === 'completed' || status === 'failed';
}

function isInsufficientCreditsError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes('INSUFFICIENT_CREDITS') ||
      error.message.includes('Insufficient credits'))
  );
}

export const ScenesView: React.FC<ScenesViewProps> = ({ sequenceId }) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const posthog = usePostHog();

  const [selectedFrameId, setSelectedFrameId] = useState<string | undefined>();
  const [selectedTab, setSelectedTab] = useState<TabValue>('scene-variants');

  const [regeneratingImages, setRegeneratingImages] = useState<Set<string>>(
    () => new Set()
  );
  const [regeneratingMotion, setRegeneratingMotion] = useState<Set<string>>(
    () => new Set()
  );
  const [regeneratingSceneVariants, setRegeneratingSceneVariants] = useState<
    Set<string>
  >(() => new Set());

  const [imageModelOverride, setImageModelOverride] = useState<string | null>(
    null
  );

  // Poll sequence while a motion batch is in flight so mergedVideoStatus stays
  // fresh. The refetchInterval fn reads from the query cache each tick to
  // avoid a circular dependency between sequence state and the poll condition.
  const { data: sequence } = useSequence(sequenceId, {
    refetchInterval: (query) => {
      const seq = query.state.data;
      if (!seq) return false;
      if (seq.mergedVideoStatus === 'merging') return 2000;
      const cachedFrames = queryClient.getQueryData<Frame[]>(
        frameKeys.list(sequenceId)
      );
      return cachedFrames?.some((f) => f.videoStatus === 'generating')
        ? 2000
        : false;
    },
  });
  const aspectRatio = sequence?.aspectRatio || DEFAULT_ASPECT_RATIO;
  const isProcessing = sequence?.status === 'processing';
  const { data: style } = useStyle(sequence?.styleId ?? '');
  const styleCategory = style?.category ?? undefined;
  const sequenceMotionModel = safeImageToVideoModel(
    sequence?.videoModel,
    DEFAULT_VIDEO_MODEL
  );
  const sequenceMusicModel = safeAudioModel(
    sequence?.musicModel,
    DEFAULT_MUSIC_MODEL
  );

  // Phase config from DB — set in stone when the workflow was triggered
  const phaseConfig = useMemo<GenerationPhaseConfig>(
    () => ({
      autoGenerateMotion: sequence?.autoGenerateMotion ?? false,
      autoGenerateMusic: sequence?.autoGenerateMusic ?? false,
    }),
    [sequence?.autoGenerateMotion, sequence?.autoGenerateMusic]
  );

  // Subscribe to real-time generation events when sequence is processing.
  // Skip history replay for non-processing sequences to avoid a brief flash of
  // the progress banner on tab re-mount caused by replaying old phase events.
  const {
    state: generationState,
    status: realtimeStatus,
    reset: resetGenerationStream,
  } = useGenerationStream(sequenceId, phaseConfig, {
    replayHistory: isProcessing,
  });

  // Hybrid polling: only poll when processing AND realtime has failed
  // - 'connecting' → wait for connection, don't poll
  // - 'connected' → use realtime, don't poll
  // - 'disconnected'/'error' → poll as fallback
  const realtimeFailed = realtimeStatus === 'error';
  const shouldPoll = isProcessing && realtimeFailed;

  // Fetch frames — only poll when processing AND realtime has failed.
  // Otherwise realtime events keep the cache fresh via updateQueryCacheFromEvent.
  const { data: frames } = useFramesBySequence(
    sequenceId,
    shouldPoll ? { refetchInterval: 2000 } : undefined
  );

  // Fetch image variants for this sequence
  const { data: imageVariants } = useQuery<FrameVariant[]>({
    queryKey: ['sequence-image-variants', sequenceId],
    queryFn: () => getSequenceImageVariantsFn({ data: { sequenceId } }),
    staleTime: 30_000,
    enabled: !!sequenceId,
  });

  // Divergent alternates + realtime stale:detected wiring (issue #625).
  // Mirror the frames-list polling fallback so the corner-dot still updates
  // when realtime is down.
  const { data: divergentVariants } = useDivergentVariants(
    sequenceId,
    shouldPoll ? { refetchInterval: 2000 } : undefined
  );
  useStaleDetected(sequenceId);
  const promoteVariant = usePromoteVariantToPrimary();
  const discardVariant = useDiscardVariant();
  const undiscardVariant = useUndiscardVariant();
  const [compareVariant, setCompareVariant] = useState<FrameVariant | null>(
    null
  );

  const handleDiscardWithUndo = useCallback(
    (variant: FrameVariant) => {
      const restore = () => {
        undiscardVariant.mutate(
          {
            sequenceId,
            frameId: variant.frameId,
            variantId: variant.id,
          },
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
        { sequenceId, frameId: variant.frameId, variantId: variant.id },
        {
          onSuccess: () => {
            // Only close the dialog after the mutation succeeds — on failure
            // the user keeps the dialog open and can retry from there.
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

  // If the frame backing the open compare dialog disappears (e.g. concurrent
  // delete from another tab), close the dialog explicitly with a toast rather
  // than silently null-rendering it.
  useEffect(() => {
    if (!compareVariant || !frames) return;
    const stillExists = frames.some((f) => f.id === compareVariant.frameId);
    if (!stillExists) {
      toast.info('Scene was removed.');
      setCompareVariant(null);
    }
  }, [compareVariant, frames]);

  const handlePromote = useCallback(
    (variant: FrameVariant) => {
      promoteVariant.mutate(
        { sequenceId, frameId: variant.frameId, variantId: variant.id },
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

  const curSelectedFrameId = selectedFrameId || frames?.[0]?.id;
  const selectedFrame = useMemo(
    () => frames?.find((frame) => frame.id === curSelectedFrameId),
    [frames, curSelectedFrameId]
  );

  // Filter variants for the currently selected frame
  const selectedFrameVariants = useMemo(() => {
    if (!imageVariants || !curSelectedFrameId) return undefined;
    return imageVariants.filter(
      (v) => v.frameId === curSelectedFrameId && v.variantType === 'image'
    );
  }, [imageVariants, curSelectedFrameId]);

  // Reset model override when switching frames
  useEffect(() => {
    setImageModelOverride(null);
  }, [curSelectedFrameId]);

  // Derive variant preview state from model override + variants
  const effectiveImageModel =
    imageModelOverride ??
    safeTextToImageModel(selectedFrame?.imageModel, DEFAULT_IMAGE_MODEL);

  const variantForSelectedModel = useMemo(() => {
    if (!selectedFrameVariants) return undefined;
    return selectedFrameVariants.find((v) => v.model === effectiveImageModel);
  }, [selectedFrameVariants, effectiveImageModel]);

  const { previewVariantUrl, playerBadgeMessage } = useMemo(() => {
    const none = { previewVariantUrl: null, playerBadgeMessage: null };
    if (selectedTab !== 'image-prompt' || !selectedFrame) return none;

    if (
      variantForSelectedModel?.status === 'completed' &&
      variantForSelectedModel.url &&
      variantForSelectedModel.url !== selectedFrame.thumbnailUrl
    ) {
      return {
        previewVariantUrl: variantForSelectedModel.url,
        playerBadgeMessage: 'Click Set Image to use',
      };
    }

    const frameImageModel = safeTextToImageModel(
      selectedFrame.imageModel,
      DEFAULT_IMAGE_MODEL
    );
    if (effectiveImageModel !== frameImageModel && !variantForSelectedModel) {
      return {
        previewVariantUrl: null,
        playerBadgeMessage: 'Click Generate Image to create',
      };
    }

    return none;
  }, [
    selectedTab,
    selectedFrame,
    effectiveImageModel,
    variantForSelectedModel,
  ]);

  const setterForType = useCallback((type: RegenerationType) => {
    switch (type) {
      case 'image':
        return setRegeneratingImages;
      case 'motion':
        return setRegeneratingMotion;
      case 'scene-variants':
        return setRegeneratingSceneVariants;
    }
  }, []);

  const handleRegenerateStart = useCallback(
    (frameId: string, type: RegenerationType) => {
      setterForType(type)((prev) => addToSet(prev, frameId));
    },
    [setterForType]
  );

  const handleRegenerateEnd = useCallback(
    (frameId: string, type: RegenerationType) => {
      setterForType(type)((prev) => removeFromSet(prev, frameId));
    },
    [setterForType]
  );

  // Auto-remove frames from regenerating sets when generation completes or fails
  useEffect(() => {
    if (!frames) return;

    for (const frame of frames) {
      if (
        regeneratingImages.has(frame.id) &&
        isTerminalStatus(frame.thumbnailStatus)
      )
        handleRegenerateEnd(frame.id, 'image');
      if (
        regeneratingMotion.has(frame.id) &&
        isTerminalStatus(frame.videoStatus)
      )
        handleRegenerateEnd(frame.id, 'motion');
      if (
        regeneratingSceneVariants.has(frame.id) &&
        isTerminalStatus(frame.variantImageStatus)
      )
        handleRegenerateEnd(frame.id, 'scene-variants');
    }
  }, [
    frames,
    regeneratingImages,
    regeneratingMotion,
    regeneratingSceneVariants,
    handleRegenerateEnd,
  ]);

  // Derive motion banner state from query data so it persists naturally across
  // tab switches — no local state needed. startedAt uses the earliest
  // generating frame's updatedAt so elapsed time stays accurate.
  const motionBannerState = useMemo(() => {
    if (!frames || !sequence) return null;
    const anyGenerating = frames.some((f) => f.videoStatus === 'generating');
    const merging = sequence.mergedVideoStatus === 'merging';
    if (!anyGenerating && !merging) return null;
    const generatingTimes = frames
      .filter((f) => f.videoStatus === 'generating')
      .map((f) => f.updatedAt.getTime());
    const startedAt =
      generatingTimes.length > 0 ? Math.min(...generatingTimes) : Date.now();
    return {
      startedAt,
      includeMusic: sequence.musicStatus === 'generating',
    };
  }, [frames, sequence]);

  const [isRetrying, setIsRetrying] = useState(false);

  const failureSummary = useMemo(
    () => (sequence ? analyzeFailures(frames ?? [], sequence) : null),
    [frames, sequence]
  );

  const handleFullRetry = useCallback(() => {
    void navigate({ to: '/sequences/$id/script', params: { id: sequenceId } });
  }, [sequenceId, navigate]);

  const handleSmartRetry = useCallback(async () => {
    setIsRetrying(true);
    try {
      const result = await smartRetryFn({ data: { sequenceId } });
      toast.success(`Retrying: ${result.retriedItems.join(', ')}`);
      void queryClient.invalidateQueries({
        queryKey: ['sequence', sequenceId],
      });
      void queryClient.invalidateQueries({ queryKey: ['frames', sequenceId] });
    } catch (error) {
      if (isInsufficientCreditsError(error)) {
        toast.error('Insufficient credits', {
          description: 'Add credits to retry.',
          action: {
            label: 'Add Credits',
            onClick: () => {
              window.location.href = '/credits';
            },
          },
        });
        void queryClient.invalidateQueries({
          queryKey: BILLING_BALANCE_KEY,
        });
      } else {
        toast.error('Failed to retry', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    } finally {
      setIsRetrying(false);
    }
  }, [sequenceId, queryClient]);

  // Handler for batch motion generation (server determines eligible frames)
  const handleBatchMotionGeneration = useCallback(
    async ({
      includeMusic,
      motionModel,
      musicModel,
      generateAudio,
    }: BatchGenerateMotionArgs) => {
      // Optimistic: compute eligible frames locally (same filter as backend)
      const eligibleFrameIds = (frames ?? [])
        .filter(
          (f) =>
            f.thumbnailStatus === 'completed' &&
            (f.videoStatus === 'pending' || f.videoStatus === 'failed')
        )
        .map((f) => f.id);

      setRegeneratingMotion((prev) => addAllToSet(prev, eligibleFrameIds));

      // Optimistically mark frames as generating in the query cache so the
      // derived banner state shows the banner immediately — no separate state.
      const eligibleSet = new Set(eligibleFrameIds);
      const now = new Date();
      queryClient.setQueryData<Frame[]>(frameKeys.list(sequenceId), (old) =>
        old?.map((f) =>
          eligibleSet.has(f.id)
            ? { ...f, videoStatus: 'generating', updatedAt: now }
            : f
        )
      );
      if (includeMusic) {
        queryClient.setQueryData<Sequence>(
          sequenceKeys.detail(sequenceId),
          (old) => (old ? { ...old, musicStatus: 'generating' } : old)
        );
      }

      posthog.capture('motion_generation_started', {
        sequence_id: sequenceId,
        include_music: includeMusic,
        eligible_frame_count: eligibleFrameIds.length,
        motion_model: motionModel,
        music_model: includeMusic ? musicModel : undefined,
        generate_audio: generateAudio,
      });

      try {
        await batchGenerateMotionFn({
          data: {
            sequenceId,
            includeMusic,
            model: motionModel,
            musicModel: includeMusic ? musicModel : undefined,
            generateAudio,
          },
        });
      } catch (error) {
        setRegeneratingMotion((prev) =>
          removeAllFromSet(prev, eligibleFrameIds)
        );
        // Roll back optimistic cache updates
        queryClient.setQueryData<Frame[]>(frameKeys.list(sequenceId), (old) =>
          old?.map((f) =>
            eligibleSet.has(f.id) ? { ...f, videoStatus: 'pending' } : f
          )
        );
        if (includeMusic) {
          void queryClient.invalidateQueries({
            queryKey: sequenceKeys.detail(sequenceId),
          });
        }

        if (isInsufficientCreditsError(error)) {
          toast.error('Insufficient credits', {
            description: 'Add credits to generate motion for all frames.',
            action: {
              label: 'Add Credits',
              onClick: () => {
                window.location.href = '/credits';
              },
            },
          });
          void queryClient.invalidateQueries({
            queryKey: BILLING_BALANCE_KEY,
          });
        } else {
          throw error;
        }
      }
    },
    [sequenceId, frames, queryClient, posthog]
  );

  const musicPromptsReady = !!(sequence?.musicPrompt && sequence.musicTags);

  // GenerationProgressBanner is owned by the script-analysis pipeline
  // (sequence.status === 'processing'). Standalone motion gen runs when the
  // sequence is already 'completed' / 'ready', so it must render via the
  // dedicated MotionProgressBanner — never the 5-stage banner. Trusting
  // generationState.currentPhase here would let leftover phase events from
  // past runs hijack the UI back to the 5-stage banner.
  const isGenerationActive = isProcessing;

  return (
    <div className="flex h-full flex-col">
      {/* Generation progress banner */}
      {isGenerationActive && (
        <div className="pl-4 pr-4 pt-4 md:pr-8">
          <GenerationProgressBanner
            generationState={generationState}
            isProcessing={isProcessing}
            startedAt={sequence?.updatedAt}
            script={sequence?.script ?? undefined}
          />
        </div>
      )}

      {/* Motion generation progress banner */}
      {!isGenerationActive &&
        motionBannerState !== null &&
        sequence &&
        frames && (
          <div className="pl-4 pr-4 pt-4 md:pr-8">
            <MotionProgressBanner
              frames={frames}
              sequence={sequence}
              includeMusic={motionBannerState.includeMusic}
              startedAt={motionBannerState.startedAt}
              onComplete={resetGenerationStream}
            />
          </div>
        )}

      {/* Failure summary with smart retry */}
      {failureSummary?.hasFailed && (
        <FailureSummaryBanner
          summary={failureSummary}
          onRetry={() => void handleSmartRetry()}
          onFullRetry={handleFullRetry}
          isRetrying={isRetrying}
        />
      )}

      <div className="flex flex-1 min-h-0">
        {/* Desktop: Scene List sidebar */}
        <div className="hidden md:block pl-4 py-4">
          <SceneList
            frames={frames}
            selectedFrameId={curSelectedFrameId}
            aspectRatio={aspectRatio}
            onSelectFrame={setSelectedFrameId}
            regeneratingImages={regeneratingImages}
            regeneratingMotion={regeneratingMotion}
            onBatchGenerateMotion={handleBatchMotionGeneration}
            musicPromptsReady={musicPromptsReady}
            hideBatchButton={
              phaseConfig.autoGenerateMotion && isGenerationActive
            }
            divergentVariants={divergentVariants}
            onCompareDivergent={(variant) => setCompareVariant(variant)}
            initialMotionModel={sequenceMotionModel}
            initialMusicModel={sequenceMusicModel}
            styleCategory={styleCategory}
          />
        </div>

        {/* Mobile: Bottom drawer */}
        <div className="md:hidden">
          <MobileSceneDrawer
            frames={frames}
            selectedFrameId={curSelectedFrameId}
            aspectRatio={aspectRatio}
            onSelectFrame={setSelectedFrameId}
            regeneratingImages={regeneratingImages}
            regeneratingMotion={regeneratingMotion}
            onBatchGenerateMotion={handleBatchMotionGeneration}
            musicPromptsReady={musicPromptsReady}
            hideBatchButton={
              phaseConfig.autoGenerateMotion && isGenerationActive
            }
            initialMotionModel={sequenceMotionModel}
            initialMusicModel={sequenceMusicModel}
            styleCategory={styleCategory}
          />
        </div>

        {/* Main content area */}
        <ScrollArea className="flex-1 px-4 md:px-8 gap-8 flex flex-col pb-20 md:pb-0 pt-4">
          <div className="flex flex-1 min-h-0 justify-center pb-8">
            <ScenePlayer
              frames={frames}
              selectedFrameId={curSelectedFrameId}
              aspectRatio={aspectRatio}
              onSelectFrame={setSelectedFrameId}
              selectedTab={selectedTab}
              overrideImageUrl={previewVariantUrl}
              badgeMessage={playerBadgeMessage}
              progressMessage={
                generationState.phases.find((p) => p.status === 'active')
                  ?.phaseName
              }
              posterUrl={sequence?.posterUrl ?? undefined}
              className={PLAYER_MAX_H}
              wrapperClassName={PLAYER_MAX_W_BY_RATIO[aspectRatio]}
            />
          </div>
          <SceneScriptPrompts
            frame={selectedFrame}
            sequenceId={sequenceId}
            selectedTab={selectedTab}
            onTabChange={setSelectedTab}
            regeneratingImages={regeneratingImages}
            regeneratingMotion={regeneratingMotion}
            regeneratingSceneVariants={regeneratingSceneVariants}
            onRegenerateStart={handleRegenerateStart}
            aspectRatio={aspectRatio}
            variantForSelectedModel={variantForSelectedModel}
            onImageModelChange={setImageModelOverride}
            styleCategory={styleCategory}
            frameDivergentVariants={divergentVariants?.filter(
              (v) => v.frameId === curSelectedFrameId
            )}
            onCompareDivergent={(variant) => setCompareVariant(variant)}
          />
        </ScrollArea>
      </div>

      {compareVariant &&
        (() => {
          const targetFrame = frames?.find(
            (f) => f.id === compareVariant.frameId
          );
          if (!targetFrame) return null;
          return (
            <CompareWithPromptDiff
              sequenceId={sequenceId}
              frame={targetFrame}
              variant={compareVariant}
              onClose={() => setCompareVariant(null)}
              onPromote={() => handlePromote(compareVariant)}
              onDiscard={() => handleDiscardWithUndo(compareVariant)}
              isPromoting={promoteVariant.isPending}
              isDiscarding={discardVariant.isPending}
            />
          );
        })()}
    </div>
  );
};
