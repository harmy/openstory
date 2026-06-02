import { BillingGateDialog } from '@/components/billing/billing-gate-dialog';
import { ImageModelSelector } from '@/components/model/image-model-selector';
import { MotionModelSelector } from '@/components/model/motion-model-selector';
import { PromptHistorySheet } from '@/components/prompts/prompt-history-sheet';
import { DivergentAlternateBanner } from '@/components/staleness/divergent-alternate-banner';
import { StalenessIndicator } from '@/components/staleness/staleness-indicator';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { shortenPromptFn } from '@/functions/ai';
import { updateFrameFn } from '@/functions/frames';
import { generateFrameImageFn } from '@/functions/frame-image';
import { generateFrameMotionFn } from '@/functions/motion-functions';
import { regenerateFramePromptFn } from '@/functions/prompt-variants';
import { BILLING_BALANCE_KEY } from '@/hooks/use-billing-balance';
import { useFalBillingGate } from '@/hooks/use-billing-gate';
import {
  frameKeys,
  useGenerateVariants,
  useSelectVariant,
  useSetImageFromVariant,
  useSetVideoFromVariant,
} from '@/hooks/use-frames';
import {
  type FrameStaleness,
  frameStalenessKey,
  useFrameStaleness,
} from '@/hooks/use-frame-staleness';
import { sequenceKeys } from '@/hooks/use-sequences';
import type { FrameVariant } from '@/lib/db/schema';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_TO_VIDEO_MODELS,
  getCompatibleModel,
  safeImageToVideoModel,
  safeTextToImageModel,
  videoModelSupportsAudio,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { resolveMotionPrompt } from '@/lib/motion/resolve-motion-prompt';
import { useFramePromptStream } from '@/lib/realtime/use-frame-prompt-stream';
import type { Frame } from '@/types/database';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CopyIcon, History, Loader2, Minimize2, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { FrameStalenessBanners } from './frame-staleness-banners';
import { SceneCastTab } from './scene-cast-tab';
import { SceneElementsTab } from './scene-elements-tab';
import { SceneLocationTab } from './scene-location-tab';
import { SceneScriptTab } from './scene-script-tab';
import { VariantSelector } from './variant-selector';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ui', 'scenes', 'scene-script-prompts']);

export type TabValue =
  | 'script'
  | 'image-prompt'
  | 'motion-prompt'
  | 'scene-variants'
  | 'cast'
  | 'location'
  | 'elements';

function isInsufficientCreditsError(error: unknown): boolean {
  if (error instanceof Error) {
    return (
      error.message.includes('INSUFFICIENT_CREDITS') ||
      error.message.includes('Insufficient credits')
    );
  }
  return false;
}

function isValidTabValue(value: string): value is TabValue {
  return (
    value === 'script' ||
    value === 'image-prompt' ||
    value === 'motion-prompt' ||
    value === 'scene-variants' ||
    value === 'cast' ||
    value === 'location' ||
    value === 'elements'
  );
}

type SceneScriptPromptsProps = {
  frame?: Frame | undefined;
  sequenceId: string;
  selectedTab: TabValue;
  onTabChange: (tab: TabValue) => void;
  regeneratingImages: Set<string>;
  regeneratingMotion: Set<string>;
  regeneratingSceneVariants: Set<string>;
  onRegenerateStart: (
    frameId: string,
    type: 'image' | 'motion' | 'scene-variants'
  ) => void;
  aspectRatio?: AspectRatio;
  variantForSelectedModel?: FrameVariant;
  /** The selected scene's video variant for the effective video model (#545). */
  videoVariantForSelectedModel?: FrameVariant;
  onImageModelChange?: (model: string) => void;
  /** Per-scene video-model preview switch (#545), mirror of onImageModelChange. */
  onVideoModelChange?: (model: string) => void;
  /** Current style category, used to show/hide style-restricted motion models */
  styleCategory?: string;
  /** Current style name, used in recommendation tooltips */
  styleName?: string;
  /** Style-recommended image model — drives the "Recommended" badge */
  recommendedImageModel?: string | null;
  /** Style-recommended video model — drives the "Recommended" badge */
  recommendedVideoModel?: string | null;
  /** Live divergent alternates for the current frame across variant types. */
  frameDivergentVariants?: FrameVariant[];
  onCompareDivergent?: (variant: FrameVariant) => void;
  /**
   * Sequence-level motion model. Used as the display fallback when the user
   * hasn't picked one in the dropdown and the frame has no completed motion.
   */
  sequenceMotionModel?: ImageToVideoModel;
};

export const SceneScriptPrompts: React.FC<SceneScriptPromptsProps> = ({
  frame,
  sequenceId,
  selectedTab,
  onTabChange,
  regeneratingImages,
  regeneratingMotion,
  regeneratingSceneVariants,
  onRegenerateStart,
  aspectRatio,
  variantForSelectedModel,
  videoVariantForSelectedModel,
  onImageModelChange,
  onVideoModelChange,
  styleCategory,
  styleName,
  recommendedImageModel,
  recommendedVideoModel,
  frameDivergentVariants,
  onCompareDivergent,
  sequenceMotionModel,
}) => {
  const divergentImageVariant = useMemo(
    () => frameDivergentVariants?.find((v) => v.variantType === 'image'),
    [frameDivergentVariants]
  );
  const divergentVideoVariant = useMemo(
    () => frameDivergentVariants?.find((v) => v.variantType === 'video'),
    [frameDivergentVariants]
  );
  const [copiedTab, setCopiedTab] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState<'visual' | 'motion' | null>(
    null
  );
  const [shortenStatus, setShortenStatus] = useState<{
    loading: boolean;
    error: string | null;
    success: string | null;
  }>({ loading: false, error: null, success: null });

  // Image & motion regeneration state
  const [editPrompts, setEditPrompts] = useState({
    imagePrompt: '' as string,
    imageModel: undefined as TextToImageModel | undefined,
    motionPrompt: '' as string,
    motionModel: undefined as ImageToVideoModel | undefined,
  });
  const {
    imagePrompt: editedImagePrompt,
    imageModel: selectedImageModel,
    motionPrompt: editedMotionPrompt,
    motionModel: selectedMotionModel,
  } = editPrompts;
  const setEditedImagePrompt = (v: string) =>
    setEditPrompts((s) => ({ ...s, imagePrompt: v }));
  const setSelectedImageModel = (v: TextToImageModel | undefined) =>
    setEditPrompts((s) => ({ ...s, imageModel: v }));
  const setEditedMotionPrompt = (v: string) =>
    setEditPrompts((s) => ({ ...s, motionPrompt: v }));
  const setSelectedMotionModel = (v: ImageToVideoModel | undefined) =>
    setEditPrompts((s) => ({ ...s, motionModel: v }));
  // SFX/dialogue toggle for audio-capable models (kling v3, veo3, etc.)
  const [generateAudio, setGenerateAudio] = useState(true);

  const handleImageModelChange = useCallback(
    (model: TextToImageModel) => {
      setSelectedImageModel(model);
      onImageModelChange?.(model);
    },
    [onImageModelChange]
  );

  // Picking a motion model both sets the regen target and (mirroring the image
  // flow) previews that model's existing video variant for this scene (#545).
  const handleMotionModelChange = useCallback(
    (model: ImageToVideoModel) => {
      setSelectedMotionModel(model);
      onVideoModelChange?.(model);
    },
    [onVideoModelChange]
  );

  // Script tab edit state — `undefined` means "no draft" (textarea mirrors the
  // saved value); a string means "user has typed". We reset to `undefined` when
  // the frame changes so switching scenes never shows the previous scene's draft.
  const [editedScript, setEditedScript] = useState<string | undefined>(
    undefined
  );
  const [editedDurationSeconds, setEditedDurationSeconds] = useState<
    number | undefined
  >(undefined);
  const prevScriptFrameIdRef = useRef<string | undefined>(undefined);

  // Previous value tracking for prop-to-state sync (refs avoid extra re-renders)
  const prevImagePromptRef = useRef<string | undefined>(undefined);
  const prevImageModelRef = useRef<string | undefined>(undefined);
  const prevMotionPromptRef = useRef<string | undefined>(undefined);
  const prevMotionModelKeyRef = useRef<string>('');

  const queryClient = useQueryClient();
  const generateVariants = useGenerateVariants();
  const selectVariant = useSelectVariant();
  const setImageFromVariant = useSetImageFromVariant();
  const setVideoFromVariant = useSetVideoFromVariant();
  const {
    needsBillingSetup: falNeedsBillingSetup,
    showGate: showFalGate,
    gateProps: falGateProps,
    stripeEnabled,
  } = useFalBillingGate();

  const { data: staleness } = useFrameStaleness({
    sequenceId,
    frameId: frame?.id,
  });
  // The realtime hook owns the per-prompt-type stream status — `'pending'`
  // covers the window between a successful enqueue and the first delta, so
  // the button stays in its busy state without a sibling useState to sync.
  const { state: framePromptStream, markPending: markPromptPending } =
    useFramePromptStream(frame?.id, Boolean(frame?.id));

  const regeneratePromptMutation = useMutation({
    mutationFn: (vars: {
      promptType: 'visual' | 'motion';
      force?: boolean;
    }) => {
      if (!frame?.id) throw new Error('frame required');
      return regenerateFramePromptFn({
        data: {
          sequenceId,
          frameId: frame.id,
          promptType: vars.promptType,
          force: vars.force,
        },
      });
    },
    // Optimistically mark the prompt as fresh so the stale-prompt banner clears
    // the moment the click registers — otherwise it lingers until the workflow
    // lands and staleness is re-queried. `isPending` flips on the same render,
    // which is what drives the button's `Regenerating…` label.
    onMutate: async (vars) => {
      if (!frame?.id) return { previous: undefined };
      const key = frameStalenessKey(frame.id);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<FrameStaleness>(key);
      if (previous) {
        const promptKey =
          vars.promptType === 'visual' ? 'visualPrompt' : 'motionPrompt';
        queryClient.setQueryData<FrameStaleness>(key, {
          ...previous,
          [promptKey]: 'fresh',
        });
      }
      return { previous };
    },
    onSuccess: async (result, vars) => {
      if (result.alreadyUpToDate) {
        toast.info('Prompt is already up to date');
      } else {
        // Workflow is now enqueued; hold the busy state via the stream's
        // `'pending'` status until deltas start arriving. Naturally cleared
        // when the DELTA/COMPLETED/FAILED reducer cases fire.
        markPromptPending(vars.promptType);
        toast.success(
          vars.promptType === 'visual'
            ? 'Regenerating visual prompt…'
            : 'Regenerating motion prompt…'
        );
      }
      if (frame?.id) {
        await queryClient.invalidateQueries({
          queryKey: frameStalenessKey(frame.id),
        });
      }
    },
    onError: (error, _vars, context) => {
      if (context?.previous && frame?.id) {
        queryClient.setQueryData(frameStalenessKey(frame.id), context.previous);
      }
      toast.error('Prompt regenerate failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

  const isAwaitingVisualPrompt =
    framePromptStream.visual.status === 'pending' ||
    framePromptStream.visual.status === 'streaming';
  const isAwaitingMotionPrompt =
    framePromptStream.motion.status === 'pending' ||
    framePromptStream.motion.status === 'streaming';
  const isStreamingVisualPrompt =
    framePromptStream.visual.status === 'streaming';
  const isStreamingMotionPrompt =
    framePromptStream.motion.status === 'streaming';

  // Surface workflow failures as a toast — the workflow runs out-of-process
  // so the regenerate mutation's onError doesn't see them.
  const visualError = framePromptStream.visual.error;
  const motionError = framePromptStream.motion.error;
  useEffect(() => {
    if (framePromptStream.visual.status === 'failed' && visualError) {
      toast.error('Visual prompt regenerate failed', {
        description: visualError,
      });
    }
  }, [framePromptStream.visual.status, visualError]);
  useEffect(() => {
    if (framePromptStream.motion.status === 'failed' && motionError) {
      toast.error('Motion prompt regenerate failed', {
        description: motionError,
      });
    }
  }, [framePromptStream.motion.status, motionError]);

  // When a streamed regen lands, the workflow has already written the new
  // variant to the DB and emitted `generation.frame:updated` — refetch so
  // the textarea swaps from the live-streamed text to the persisted prompt
  // without a flicker.
  const frameId = frame?.id;
  useEffect(() => {
    if (!frameId) return;
    if (framePromptStream.visual.status !== 'completed') return;
    void queryClient.invalidateQueries({
      queryKey: frameKeys.detail(frameId),
    });
    void queryClient.invalidateQueries({
      queryKey: frameKeys.list(sequenceId),
    });
    void queryClient.invalidateQueries({
      queryKey: frameStalenessKey(frameId),
    });
  }, [framePromptStream.visual.status, frameId, sequenceId, queryClient]);
  useEffect(() => {
    if (!frameId) return;
    if (framePromptStream.motion.status !== 'completed') return;
    void queryClient.invalidateQueries({
      queryKey: frameKeys.detail(frameId),
    });
    void queryClient.invalidateQueries({
      queryKey: frameKeys.list(sequenceId),
    });
    void queryClient.invalidateQueries({
      queryKey: frameStalenessKey(frameId),
    });
  }, [framePromptStream.motion.status, frameId, sequenceId, queryClient]);

  // Persist a scene-script and/or duration edit. Sends the patched scene via
  // `metadata`; `updateFrameFn` (server) clears stale dialogue (when extract
  // changes) and mirrors the new extract into `sequences.script`. Existing
  // prompt-input-hash staleness lights up the Image/Motion banners
  // automatically once the new scene metadata lands.
  const saveScriptMutation = useMutation({
    mutationFn: async (input: {
      nextExtract: string;
      nextDurationSeconds: number | undefined;
    }) => {
      if (!frame?.id || !frame.metadata) {
        throw new Error('frame metadata required');
      }
      const { nextExtract, nextDurationSeconds } = input;
      const updated = await updateFrameFn({
        data: {
          sequenceId,
          frameId: frame.id,
          ...(nextDurationSeconds !== undefined
            ? { durationMs: Math.round(nextDurationSeconds * 1000) }
            : {}),
          metadata: {
            ...frame.metadata,
            originalScript: {
              ...frame.metadata.originalScript,
              extract: nextExtract,
            },
            ...(nextDurationSeconds !== undefined
              ? {
                  metadata: {
                    ...(frame.metadata.metadata ?? {
                      title: '',
                      location: '',
                      timeOfDay: '',
                      storyBeat: '',
                    }),
                    durationSeconds: nextDurationSeconds,
                  },
                }
              : {}),
          },
        },
      });
      if (!updated) {
        throw new Error('Frame update returned no data');
      }
      return updated;
    },
    onSuccess: async (updated) => {
      setEditedScript(undefined);
      setEditedDurationSeconds(undefined);
      queryClient.setQueryData(frameKeys.detail(updated.id), updated);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: frameKeys.list(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: frameStalenessKey(updated.id),
        }),
        queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequenceId),
        }),
      ]);
      toast.success('Scene saved');
    },
    onError: (error) => {
      toast.error('Failed to save scene', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

  // Per-prompt-type busy flag — `regeneratePromptMutation.variables` is the
  // payload of the in-flight request, so we know which tab's regenerate
  // triggered it. Without this, both tabs' indicators would show busy whenever
  // either was clicked.
  const inFlightPromptType = regeneratePromptMutation.isPending
    ? regeneratePromptMutation.variables?.promptType
    : null;
  const isRegeneratingVisualPrompt =
    inFlightPromptType === 'visual' || isAwaitingVisualPrompt;
  const isRegeneratingMotionPrompt =
    inFlightPromptType === 'motion' || isAwaitingMotionPrompt;

  const handleCopy = useCallback(
    async (text: string | undefined, tabName: string) => {
      if (!text) return;

      try {
        await navigator.clipboard.writeText(text);
        setCopiedTab(tabName);
        setTimeout(() => setCopiedTab(null), 2000);
      } catch (error) {
        toast.error('Failed to copy', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
    []
  );

  // Get imagePrompt early so it can be used in handleShortenPrompt
  const scriptText = frame?.metadata?.originalScript.extract;
  const imageModel = safeTextToImageModel(
    frame?.imageModel,
    DEFAULT_IMAGE_MODEL
  );
  const imagePrompt =
    frame?.imagePrompt || frame?.metadata?.prompts?.visual?.fullPrompt;

  const variantIsCompleted =
    variantForSelectedModel?.status === 'completed' &&
    !!variantForSelectedModel.url;
  const variantIsGenerating = variantForSelectedModel?.status === 'generating';
  const variantAlreadySet =
    variantIsCompleted && variantForSelectedModel.url === frame?.thumbnailUrl;

  const handleSetImageFromVariant = useCallback(async () => {
    if (!frame?.id || !frame.sequenceId || !selectedImageModel) return;

    try {
      await setImageFromVariant.mutateAsync({
        sequenceId: frame.sequenceId,
        frameId: frame.id,
        model: selectedImageModel,
      });
    } catch (error) {
      toast.error('Failed to set image', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, [frame, selectedImageModel, setImageFromVariant]);

  // Video equivalents (#545): drive the "Set Video" action from the selected
  // scene's video variant for the picked model.
  const videoVariantIsCompleted =
    videoVariantForSelectedModel?.status === 'completed' &&
    !!videoVariantForSelectedModel.url;
  const videoVariantIsGenerating =
    videoVariantForSelectedModel?.status === 'generating';
  const videoVariantAlreadySet =
    videoVariantIsCompleted &&
    videoVariantForSelectedModel.url === frame?.videoUrl;

  const handleSetVideoFromVariant = useCallback(async () => {
    if (!frame?.id || !frame.sequenceId || !selectedMotionModel) return;

    try {
      await setVideoFromVariant.mutateAsync({
        sequenceId: frame.sequenceId,
        frameId: frame.id,
        model: selectedMotionModel,
      });
    } catch (error) {
      toast.error('Failed to set video', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, [frame, selectedMotionModel, setVideoFromVariant]);

  const handleShortenPrompt = useCallback(async () => {
    setShortenStatus({ loading: false, error: null, success: null });

    const currentPrompt = editedImagePrompt || imagePrompt;
    if (!currentPrompt || currentPrompt.length < 20) {
      setShortenStatus((s) => ({
        ...s,
        error: 'Prompt is too short to shorten',
      }));
      return;
    }

    setShortenStatus((s) => ({ ...s, loading: true }));

    try {
      const result = await shortenPromptFn({ data: { prompt: currentPrompt } });

      setEditedImagePrompt(result.shortenedPrompt);
      const msg = `Prompt shortened by ${result.reductionPercent}% (${result.originalLength} → ${result.shortenedLength} chars)`;
      setShortenStatus({ loading: false, error: null, success: msg });
      // Clear success message after 5 seconds
      setTimeout(
        () => setShortenStatus((s) => ({ ...s, success: null })),
        5000
      );
    } catch (error) {
      logger.error('Failed to shorten prompt:', { err: error });
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to shorten prompt';
      setShortenStatus({ loading: false, error: errorMessage, success: null });
    }
  }, [editedImagePrompt, imagePrompt]);

  const handleRegenerate = useCallback(async () => {
    if (!frame?.id || !frame.sequenceId) return;

    onRegenerateStart(frame.id, 'image');

    // Optimistic update for frame list query
    queryClient.setQueryData<Frame[]>(
      frameKeys.list(frame.sequenceId),
      (oldFrames) => {
        if (!oldFrames) return oldFrames;
        return oldFrames.map((f) =>
          f.id === frame.id
            ? {
                ...f,
                thumbnailStatus: 'generating' as const,
                imagePrompt: editedImagePrompt || f.imagePrompt,
                imageModel: selectedImageModel || f.imageModel,
              }
            : f
        );
      }
    );

    // Optimistic update for individual frame query
    queryClient.setQueryData<Frame>(frameKeys.detail(frame.id), (oldFrame) => {
      if (!oldFrame) return oldFrame;
      return {
        ...oldFrame,
        thumbnailStatus: 'generating' as const,
        imagePrompt: editedImagePrompt || oldFrame.imagePrompt,
        imageModel: selectedImageModel || oldFrame.imageModel,
      };
    });

    try {
      await generateFrameImageFn({
        data: {
          sequenceId: frame.sequenceId,
          frameId: frame.id,
          model: selectedImageModel,
          prompt: editedImagePrompt || undefined,
        },
      });

      // Don't invalidate immediately - let auto-polling pick up server updates
      // The optimistic update shows 'generating' instantly, and the workflow
      // will update the server status which auto-polling will detect
    } catch (error) {
      if (isInsufficientCreditsError(error)) {
        showFalGate();
        void queryClient.invalidateQueries({
          queryKey: [...BILLING_BALANCE_KEY],
        });
      } else {
        toast.error('Image generation failed', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      // Rollback on error - set status to failed
      await queryClient.invalidateQueries({
        queryKey: frameKeys.list(frame.sequenceId),
      });
      await queryClient.invalidateQueries({
        queryKey: frameKeys.detail(frame.id),
      });
    }
  }, [
    frame,
    selectedImageModel,
    editedImagePrompt,
    queryClient,
    onRegenerateStart,
    showFalGate,
  ]);

  const handleRegenerateMotion = useCallback(async () => {
    if (!frame?.id || !frame.sequenceId) return;

    onRegenerateStart(frame.id, 'motion');

    // Optimistic update for frame list query
    queryClient.setQueryData<Frame[]>(
      frameKeys.list(frame.sequenceId),
      (oldFrames) => {
        if (!oldFrames) return oldFrames;
        return oldFrames.map((f) =>
          f.id === frame.id
            ? {
                ...f,
                videoStatus: 'generating' as const,
                motionPrompt: editedMotionPrompt || f.motionPrompt,
                motionModel: selectedMotionModel || f.motionModel,
              }
            : f
        );
      }
    );

    // Optimistic update for individual frame query
    queryClient.setQueryData<Frame>(frameKeys.detail(frame.id), (oldFrame) => {
      if (!oldFrame) return oldFrame;
      return {
        ...oldFrame,
        videoStatus: 'generating' as const,
        motionPrompt: editedMotionPrompt || oldFrame.motionPrompt,
        motionModel: selectedMotionModel || oldFrame.motionModel,
      };
    });

    const motionModelForCall = selectedMotionModel || DEFAULT_VIDEO_MODEL;
    const supportsAudio = videoModelSupportsAudio(motionModelForCall);

    try {
      await generateFrameMotionFn({
        data: {
          sequenceId: frame.sequenceId,
          frameId: frame.id,
          model: selectedMotionModel,
          prompt: editedMotionPrompt || undefined,
          generateAudio: supportsAudio ? generateAudio : undefined,
        },
      });

      // Don't invalidate immediately - let auto-polling pick up server updates
    } catch (error) {
      if (isInsufficientCreditsError(error)) {
        showFalGate();
        void queryClient.invalidateQueries({
          queryKey: [...BILLING_BALANCE_KEY],
        });
      } else {
        toast.error('Motion generation failed', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      // Rollback on error
      await queryClient.invalidateQueries({
        queryKey: frameKeys.list(frame.sequenceId),
      });
      await queryClient.invalidateQueries({
        queryKey: frameKeys.detail(frame.id),
      });
    }
  }, [
    frame,
    selectedMotionModel,
    editedMotionPrompt,
    generateAudio,
    queryClient,
    onRegenerateStart,
    showFalGate,
  ]);

  const handleGenerateSceneVariants = useCallback(async () => {
    if (!frame?.id || !frame.sequenceId) return;

    onRegenerateStart(frame.id, 'scene-variants');

    try {
      await generateVariants.mutateAsync({
        sequenceId: frame.sequenceId,
        frameId: frame.id,
        model: selectedImageModel,
      });
    } catch (error) {
      toast.error('Scene variants generation failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }, [frame, generateVariants, selectedImageModel, onRegenerateStart]);

  const handleVariantSelect = useCallback(
    async (index: number) => {
      if (!frame?.id || !frame.sequenceId) return;
      try {
        await selectVariant.mutateAsync({
          sequenceId: frame.sequenceId,
          frameId: frame.id,
          variantIndex: index,
        });
      } catch (error) {
        toast.error('Failed to select variant', {
          description: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    },
    [frame, selectVariant]
  );

  const motionPromptData = frame?.metadata?.prompts?.motion;

  // Raw prompt for editing (just motion direction, no dialogue/audio)
  const rawMotionPrompt =
    frame?.motionPrompt || motionPromptData?.fullPrompt || '';

  // Resolved motion model for this scene. Precedence:
  //   1. user picked one in the dropdown right now
  //   2. frame already has completed motion → show what it was generated with
  //   3. sequence-level model (reflects most recent batch pick or creation)
  //   4. global default
  // Without (2) and (3) the per-frame label would just show DEFAULT_VIDEO_MODEL
  // regardless of what was actually used or what batch-generate just selected.
  const effectiveMotionModel: ImageToVideoModel =
    selectedMotionModel ||
    (frame?.videoStatus === 'completed' && frame.motionModel
      ? safeImageToVideoModel(frame.motionModel, DEFAULT_VIDEO_MODEL)
      : undefined) ||
    sequenceMotionModel ||
    DEFAULT_VIDEO_MODEL;

  // Assembled preview: exactly what resolveMotionPrompt produces on the server
  const assembledPrompt = useMemo(() => {
    const promptOverride = editedMotionPrompt || rawMotionPrompt;
    return resolveMotionPrompt(
      {
        motionPrompt: promptOverride || null,
        metadata: frame?.metadata ?? null,
        description: frame?.description ?? null,
      },
      effectiveMotionModel
    );
  }, [
    editedMotionPrompt,
    rawMotionPrompt,
    frame?.metadata,
    frame?.description,
    effectiveMotionModel,
  ]);

  const motionModel = effectiveMotionModel;
  const maxPromptLength = IMAGE_TO_VIDEO_MODELS[motionModel].maxPromptLength;
  const isOverLimit = assembledPrompt.length > maxPromptLength;

  // Sync local state when props change (prev-value refs avoid extra re-renders)
  if (frame?.id !== prevScriptFrameIdRef.current) {
    prevScriptFrameIdRef.current = frame?.id;
    setEditedScript(undefined);
    setEditedDurationSeconds(undefined);
  }

  if (imagePrompt !== prevImagePromptRef.current) {
    prevImagePromptRef.current = imagePrompt;
    setEditedImagePrompt(imagePrompt || '');
  }

  if (frame?.imageModel !== prevImageModelRef.current) {
    prevImageModelRef.current = frame?.imageModel;
    setSelectedImageModel(
      safeTextToImageModel(frame?.imageModel, DEFAULT_IMAGE_MODEL)
    );
  }

  if (rawMotionPrompt !== prevMotionPromptRef.current) {
    prevMotionPromptRef.current = rawMotionPrompt;
    setEditedMotionPrompt(rawMotionPrompt);
  }

  const motionModelKey = `${frame?.motionModel ?? ''}:${aspectRatio ?? ''}:${styleCategory ?? ''}`;
  if (motionModelKey !== prevMotionModelKeyRef.current) {
    prevMotionModelKeyRef.current = motionModelKey;
    const currentModel = frame?.motionModel
      ? safeImageToVideoModel(frame.motionModel)
      : DEFAULT_VIDEO_MODEL;
    const compatibleModel = aspectRatio
      ? getCompatibleModel(currentModel, aspectRatio)
      : currentModel;
    // Fall back if the model requires a style category that doesn't match
    const modelConfig = IMAGE_TO_VIDEO_MODELS[compatibleModel];
    const finalModel =
      'requiredStyleCategory' in modelConfig &&
      modelConfig.requiredStyleCategory !== styleCategory
        ? DEFAULT_VIDEO_MODEL
        : compatibleModel;
    setSelectedMotionModel(finalModel);
  }

  // Check if image is currently generating
  const isGenerating =
    frame?.thumbnailStatus === 'generating' ||
    (frame?.id ? regeneratingImages.has(frame.id) : false);

  // Check if motion is currently generating
  const isGeneratingMotion =
    frame?.videoStatus === 'generating' ||
    (frame?.id ? regeneratingMotion.has(frame.id) : false);

  const isGeneratingSceneVariants =
    frame?.variantImageStatus === 'generating' ||
    (frame?.id ? regeneratingSceneVariants.has(frame.id) : false);

  return (
    <Tabs
      value={selectedTab}
      onValueChange={(value) => {
        if (isValidTabValue(value)) {
          onTabChange(value);
        }
      }}
      className="w-full"
    >
      <FrameStalenessBanners
        frameId={frame?.id}
        sequenceId={sequenceId}
        onRegenerate={() => {
          onTabChange('image-prompt');
          if (falNeedsBillingSetup) {
            showFalGate();
            return;
          }
          void handleRegenerate();
        }}
      />

      {/* Mobile: Select dropdown */}
      <div className="md:hidden">
        <Select
          value={selectedTab}
          onValueChange={(value) => {
            if (isValidTabValue(value)) {
              onTabChange(value);
            }
          }}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="scene-variants">Variants</SelectItem>
            <SelectItem value="script">Script</SelectItem>
            <SelectItem value="cast">Cast</SelectItem>
            <SelectItem value="location">Location</SelectItem>
            <SelectItem value="elements">Elements</SelectItem>
            <SelectItem value="image-prompt">Image</SelectItem>
            <SelectItem value="motion-prompt">Motion</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Desktop: Tab buttons */}
      <TabsList className="hidden md:flex">
        <TabsTrigger value="scene-variants">Variants</TabsTrigger>
        <TabsTrigger value="script">Script</TabsTrigger>
        <TabsTrigger value="cast">Cast</TabsTrigger>
        <TabsTrigger value="location">Location</TabsTrigger>
        <TabsTrigger value="elements">Elements</TabsTrigger>
        <TabsTrigger value="image-prompt" className="gap-1.5">
          Image
          {staleness?.visualPrompt === 'stale' && (
            <StalenessIndicator
              artifact="visual-prompt"
              entityType="frame"
              density="corner-dot"
              isRegenerating={isRegeneratingVisualPrompt}
            />
          )}
        </TabsTrigger>
        <TabsTrigger value="motion-prompt" className="gap-1.5">
          Motion
          {staleness?.motionPrompt === 'stale' && (
            <StalenessIndicator
              artifact="motion-prompt"
              entityType="frame"
              density="corner-dot"
              isRegenerating={isRegeneratingMotionPrompt}
            />
          )}
        </TabsTrigger>
      </TabsList>

      <TabsContent value="script">
        <SceneScriptTab
          frame={frame}
          sequenceId={sequenceId}
          scriptText={scriptText}
          motionModel={selectedMotionModel || DEFAULT_VIDEO_MODEL}
          editedScript={editedScript}
          onEditedScriptChange={setEditedScript}
          editedDurationSeconds={editedDurationSeconds}
          onEditedDurationChange={setEditedDurationSeconds}
          isSaving={saveScriptMutation.isPending}
          onSave={(payload) => saveScriptMutation.mutate(payload)}
          isCopied={copiedTab === 'script'}
          onCopy={(text) => void handleCopy(text, 'script')}
        />
      </TabsContent>

      <TabsContent value="image-prompt">
        <div className="space-y-4">
          {/* Error/Success Messages */}
          {shortenStatus.error && (
            <Alert variant="destructive">
              <AlertDescription>{shortenStatus.error}</AlertDescription>
            </Alert>
          )}

          {shortenStatus.success && (
            <Alert>
              <AlertDescription>{shortenStatus.success}</AlertDescription>
            </Alert>
          )}

          {/* Editable prompt */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label
                htmlFor="image-prompt-input"
                className="text-sm font-medium"
              >
                Prompt
              </label>
              <span className="text-xs text-muted-foreground">
                {(editedImagePrompt || imagePrompt || '').length} characters
              </span>
            </div>
            <Textarea
              id="image-prompt-input"
              value={
                isStreamingVisualPrompt
                  ? framePromptStream.visual.text
                  : editedImagePrompt || imagePrompt || ''
              }
              onChange={(e) => setEditedImagePrompt(e.target.value)}
              placeholder={
                isStreamingVisualPrompt
                  ? 'Streaming prompt…'
                  : isGenerating
                    ? 'Prompt is being generated…'
                    : 'Enter image prompt…'
              }
              className="min-h-[120px] resize-y"
              disabled={isGenerating || isStreamingVisualPrompt}
            />
          </div>

          {/* Model selector */}
          <div className="space-y-2">
            <span className="text-sm font-medium">Model</span>
            <ImageModelSelector
              selectedModel={selectedImageModel || imageModel}
              onModelChange={handleImageModelChange}
              disabled={isGenerating}
              recommendedImageModel={recommendedImageModel}
              styleName={styleName}
            />
          </div>

          {/* Shorten + History buttons */}
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => void handleShortenPrompt()}
              disabled={
                shortenStatus.loading ||
                isGenerating ||
                !editedImagePrompt ||
                editedImagePrompt.length < 20
              }
              className="flex-1"
            >
              {shortenStatus.loading && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {!shortenStatus.loading && <Minimize2 className="mr-2 h-4 w-4" />}
              {shortenStatus.loading ? 'Shortening…' : 'Shorten Prompt'}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => setHistoryOpen('visual')}
              disabled={!frame}
              aria-label="Show visual prompt history"
            >
              <History className="mr-2 h-4 w-4" />
              History
            </Button>
          </div>

          {/* Prompt-stale regenerate banner */}
          {staleness?.visualPrompt === 'stale' && (
            <StalenessIndicator
              artifact="visual-prompt"
              entityType="frame"
              density="inline"
              onRegenerate={() =>
                regeneratePromptMutation.mutate({ promptType: 'visual' })
              }
              isRegenerating={isRegeneratingVisualPrompt}
            />
          )}

          {/* Explicit regenerate-prompt button — streams a fresh LLM
              completion straight into the textarea so the user sees the
              prompt forming. Routed through the shared mutation so
              `isPending` flips synchronously on click and the busy state
              shows instantly, instead of waiting for the realtime channel's
              first delta. */}
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              regeneratePromptMutation.mutate({
                promptType: 'visual',
                force: true,
              })
            }
            disabled={!frame || isRegeneratingVisualPrompt}
            className="w-full"
            aria-label="Regenerate visual prompt"
          >
            {isRegeneratingVisualPrompt ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {isRegeneratingVisualPrompt ? 'Regenerating…' : 'Regenerate Prompt'}
          </Button>

          {divergentImageVariant && (
            <DivergentAlternateBanner
              variantId={divergentImageVariant.id}
              artifact="thumbnail"
              entityType="frame"
              onCompare={() => onCompareDivergent?.(divergentImageVariant)}
            />
          )}

          {/* Image action button — variant-aware */}
          {variantIsCompleted && !variantAlreadySet ? (
            <Button
              onClick={() => void handleSetImageFromVariant()}
              disabled={setImageFromVariant.isPending || !frame}
              className="w-full"
            >
              {setImageFromVariant.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {setImageFromVariant.isPending ? 'Setting…' : 'Set Image'}
            </Button>
          ) : (
            <Button
              onClick={() => {
                if (falNeedsBillingSetup) {
                  showFalGate();
                  return;
                }
                void handleRegenerate();
              }}
              disabled={isGenerating || variantIsGenerating || !frame}
              className="w-full"
            >
              {(isGenerating || variantIsGenerating) && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {isGenerating || variantIsGenerating
                ? 'Generating…'
                : variantAlreadySet
                  ? 'Regenerate Image'
                  : 'Generate Image'}
            </Button>
          )}

          {/* Copy button for current prompt */}
          <Button
            variant="outline"
            onClick={() =>
              void handleCopy(editedImagePrompt || imagePrompt, 'image-prompt')
            }
            disabled={!imagePrompt}
            className="w-full"
          >
            {copiedTab === 'image-prompt' ? (
              <span className="flex items-center gap-2">
                <span className="text-xs">✓</span> Copied
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <CopyIcon className="h-4 w-4" /> Copy Prompt
              </span>
            )}
          </Button>
        </div>
      </TabsContent>

      <TabsContent value="motion-prompt">
        <div className="space-y-4">
          {/* Editable raw motion prompt */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label
                htmlFor="motion-prompt-input"
                className="text-sm font-medium"
              >
                Prompt
              </label>
              <span className="text-xs text-muted-foreground">
                {(editedMotionPrompt || rawMotionPrompt).length} characters
              </span>
            </div>
            <Textarea
              id="motion-prompt-input"
              value={
                isStreamingMotionPrompt
                  ? framePromptStream.motion.text
                  : editedMotionPrompt || rawMotionPrompt
              }
              onChange={(e) => setEditedMotionPrompt(e.target.value)}
              placeholder={
                isStreamingMotionPrompt
                  ? 'Streaming prompt…'
                  : isGeneratingMotion
                    ? 'Prompt is being generated…'
                    : 'Enter motion prompt…'
              }
              className="min-h-[120px] resize-y"
              disabled={
                isGenerating || isGeneratingMotion || isStreamingMotionPrompt
              }
            />
          </div>

          {/* Model selector */}
          <div className="space-y-2">
            <span className="text-sm font-medium">Model</span>
            <MotionModelSelector
              selectedModel={effectiveMotionModel}
              onModelChange={handleMotionModelChange}
              disabled={isGenerating || isGeneratingMotion}
              aspectRatio={aspectRatio}
              styleCategory={styleCategory}
              recommendedVideoModel={recommendedVideoModel}
              styleName={styleName}
            />
          </div>

          {/* Assembled prompt preview */}
          {assembledPrompt && assembledPrompt !== editedMotionPrompt && (
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span
                  id="motion-assembled-prompt-heading"
                  className="text-sm font-medium"
                >
                  Optimised prompt
                </span>
                <span
                  className={`text-xs ${isOverLimit ? 'text-destructive font-medium' : 'text-muted-foreground'}`}
                >
                  {assembledPrompt.length}&nbsp;/&nbsp;{maxPromptLength}
                </span>
              </div>
              <p
                id="motion-assembled-prompt-preview"
                aria-labelledby="motion-assembled-prompt-heading"
                className="whitespace-pre-wrap rounded-md border bg-muted/50 p-3 text-sm leading-relaxed text-foreground"
              >
                {assembledPrompt}
              </p>
            </div>
          )}

          {/* History button */}
          <Button
            type="button"
            variant="outline"
            onClick={() => setHistoryOpen('motion')}
            disabled={!frame}
            className="w-full"
            aria-label="Show motion prompt history"
          >
            <History className="mr-2 h-4 w-4" />
            History
          </Button>

          {/* Prompt-stale regenerate banner */}
          {staleness?.motionPrompt === 'stale' && (
            <StalenessIndicator
              artifact="motion-prompt"
              entityType="frame"
              density="inline"
              onRegenerate={() =>
                regeneratePromptMutation.mutate({ promptType: 'motion' })
              }
              isRegenerating={isRegeneratingMotionPrompt}
            />
          )}

          {/* Explicit regenerate-prompt button — streams a fresh LLM
              completion straight into the textarea. See the image-prompt tab
              for the full rationale. */}
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              regeneratePromptMutation.mutate({
                promptType: 'motion',
                force: true,
              })
            }
            disabled={!frame || isRegeneratingMotionPrompt}
            className="w-full"
            aria-label="Regenerate motion prompt"
          >
            {isRegeneratingMotionPrompt ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-4 w-4" />
            )}
            {isRegeneratingMotionPrompt ? 'Regenerating…' : 'Regenerate Prompt'}
          </Button>

          {divergentVideoVariant && (
            <DivergentAlternateBanner
              variantId={divergentVideoVariant.id}
              artifact="video"
              entityType="frame"
              onCompare={() => onCompareDivergent?.(divergentVideoVariant)}
            />
          )}

          {/* SFX/dialogue toggle — only for audio-capable models */}
          {videoModelSupportsAudio(
            selectedMotionModel || DEFAULT_VIDEO_MODEL
          ) && (
            <label
              htmlFor="scene-generate-audio"
              className="flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Checkbox
                id="scene-generate-audio"
                checked={generateAudio}
                onCheckedChange={(checked) =>
                  setGenerateAudio(checked === true)
                }
                disabled={isGenerating || isGeneratingMotion}
              />
              <span>Include SFX &amp; dialogue</span>
            </label>
          )}

          {/* Motion action button — variant-aware (#545), mirror of the image
              tab: when the picked model already has a completed video for this
              scene, offer to Set it; otherwise Generate/Regenerate. */}
          {videoVariantIsCompleted && !videoVariantAlreadySet ? (
            <Button
              onClick={() => void handleSetVideoFromVariant()}
              disabled={setVideoFromVariant.isPending || !frame}
              className="w-full"
            >
              {setVideoFromVariant.isPending && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {setVideoFromVariant.isPending ? 'Setting…' : 'Set Video'}
            </Button>
          ) : (
            <Button
              onClick={() => {
                if (falNeedsBillingSetup) {
                  showFalGate();
                  return;
                }
                void handleRegenerateMotion();
              }}
              disabled={
                isGenerating ||
                isGeneratingMotion ||
                videoVariantIsGenerating ||
                !frame
              }
              className="w-full"
            >
              {(isGeneratingMotion || videoVariantIsGenerating) && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {isGeneratingMotion || videoVariantIsGenerating
                ? 'Generating…'
                : frame?.videoUrl
                  ? 'Regenerate Motion'
                  : 'Generate Motion'}
            </Button>
          )}

          {/* Copy button for assembled prompt */}
          <Button
            variant="outline"
            onClick={() => void handleCopy(assembledPrompt, 'motion-prompt')}
            disabled={!assembledPrompt}
            className="w-full"
          >
            {copiedTab === 'motion-prompt' ? (
              <span className="flex items-center gap-2">
                <span className="text-xs">✓</span> Copied
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <CopyIcon className="h-4 w-4" /> Copy Prompt
              </span>
            )}
          </Button>
        </div>
      </TabsContent>

      <TabsContent value="scene-variants">
        <div className="space-y-4">
          {/* Variant Selector */}
          {frame?.variantImageUrl ? (
            <VariantSelector
              variantImageUrl={frame.variantImageUrl}
              selectedVariantIndex={null} // TODO: Store selected variant index in frame metadata if needed
              onVariantSelect={(index) => void handleVariantSelect(index)}
              loading={isGeneratingSceneVariants || selectVariant.isPending}
              disabled={isGeneratingSceneVariants || selectVariant.isPending}
              aspectRatio={aspectRatio}
            />
          ) : (
            <div className="rounded-lg border border-dashed border-muted-foreground/30 p-8 text-center text-sm text-muted-foreground">
              No variant image available. Generate variants to see options.
            </div>
          )}

          {/* Model selector */}
          <div className="space-y-2">
            <span className="text-sm font-medium">Model</span>
            <ImageModelSelector
              selectedModel={selectedImageModel || imageModel}
              onModelChange={handleImageModelChange}
              disabled={isGenerating || isGeneratingSceneVariants}
              recommendedImageModel={recommendedImageModel}
              styleName={styleName}
            />
          </div>

          {/* Regenerate button */}
          <Button
            onClick={() => {
              if (falNeedsBillingSetup) {
                showFalGate();
                return;
              }
              void handleGenerateSceneVariants();
            }}
            disabled={
              isGenerating ||
              isGeneratingSceneVariants ||
              generateVariants.isPending ||
              !frame
            }
            className="w-full"
          >
            {(isGeneratingSceneVariants || generateVariants.isPending) && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {isGeneratingSceneVariants || generateVariants.isPending
              ? 'Generating…'
              : frame?.variantImageUrl
                ? 'Regenerate Scene Variants'
                : 'Generate Scene Variants'}
          </Button>
        </div>
      </TabsContent>

      <TabsContent value="cast">
        <SceneCastTab frame={frame} sequenceId={sequenceId} />
      </TabsContent>

      <TabsContent value="location">
        <SceneLocationTab frame={frame} sequenceId={sequenceId} />
      </TabsContent>

      <TabsContent value="elements">
        <SceneElementsTab frame={frame} sequenceId={sequenceId} />
      </TabsContent>

      <BillingGateDialog {...falGateProps} stripeEnabled={stripeEnabled} />

      {frame?.id && historyOpen && (
        <PromptHistorySheet
          open
          onOpenChange={(open) => !open && setHistoryOpen(null)}
          mode={historyOpen}
          sequenceId={sequenceId}
          frameId={frame.id}
          currentText={
            historyOpen === 'visual' ? imagePrompt || '' : rawMotionPrompt || ''
          }
        />
      )}
    </Tabs>
  );
};
