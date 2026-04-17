import { BillingGateDialog } from '@/components/billing/billing-gate-dialog';
import { ImageModelSelector } from '@/components/model/image-model-selector';
import { MotionModelSelector } from '@/components/model/motion-model-selector';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { shortenPromptFn } from '@/functions/ai';
import { generateFrameImageFn } from '@/functions/frame-image';
import { generateFrameMotionFn } from '@/functions/motion-functions';
import { BILLING_BALANCE_KEY } from '@/hooks/use-billing-balance';
import { useFalBillingGate } from '@/hooks/use-billing-gate';
import {
  frameKeys,
  useGenerateVariants,
  useSelectVariant,
  useSetImageFromVariant,
} from '@/hooks/use-frames';
import type { FrameVariant } from '@/lib/db/schema';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_TO_VIDEO_MODELS,
  getCompatibleModel,
  safeImageToVideoModel,
  safeTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { resolveMotionPrompt } from '@/lib/motion/resolve-motion-prompt';
import type { Frame } from '@/types/database';
import { useQueryClient } from '@tanstack/react-query';
import { CopyIcon, Loader2, Minimize2 } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { SceneCastTab } from './scene-cast-tab';
import { SceneLocationTab } from './scene-location-tab';
import { VariantSelector } from './variant-selector';

export type TabValue =
  | 'script'
  | 'image-prompt'
  | 'motion-prompt'
  | 'scene-variants'
  | 'cast'
  | 'location';

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
    value === 'location'
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
  onImageModelChange?: (model: string) => void;
  /** Current style category, used to show/hide style-restricted motion models */
  styleCategory?: string;
};

type PromptTabContentProps = {
  text: string | undefined;
  isCopied: boolean;
  onCopy: () => void;
  showDuration?: boolean;
  durationMs?: number | null;
};

const PromptTabContent: React.FC<PromptTabContentProps> = ({
  text,
  isCopied,
  onCopy,
  showDuration,
  durationMs,
}) => {
  return (
    <div className="space-y-3">
      <div className="relative">
        <div className="absolute right-0 top-0">
          <Button
            size="sm"
            variant="ghost"
            onClick={onCopy}
            disabled={!text}
            className="h-8 w-8 p-0"
          >
            {isCopied ? (
              <span className="text-xs">✓</span>
            ) : (
              <CopyIcon className="h-4 w-4" />
            )}
          </Button>
        </div>
        <div className="prose prose-sm max-w-none pr-10">
          {text ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-foreground">
              {text}
            </p>
          ) : (
            <div className="space-y-2">
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-11/12" />
              <Skeleton className="h-4 w-10/12" />
              <Skeleton className="h-4 w-9/12" />
            </div>
          )}
        </div>
      </div>
      {showDuration &&
        durationMs !== undefined &&
        durationMs !== null &&
        durationMs > 0 && (
          <div className="text-xs text-muted-foreground">
            Duration: {(durationMs / 1000).toFixed(1)}s
          </div>
        )}
    </div>
  );
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
  onImageModelChange,
  styleCategory,
}) => {
  const [copiedTab, setCopiedTab] = useState<string | null>(null);
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

  const handleImageModelChange = useCallback(
    (model: TextToImageModel) => {
      setSelectedImageModel(model);
      onImageModelChange?.(model);
    },
    [onImageModelChange]
  );

  // Previous value tracking for prop-to-state sync (refs avoid extra re-renders)
  const prevImagePromptRef = useRef<string | undefined>(undefined);
  const prevImageModelRef = useRef<string | undefined>(undefined);
  const prevMotionPromptRef = useRef<string | undefined>(undefined);
  const prevMotionModelKeyRef = useRef<string>('');

  const queryClient = useQueryClient();
  const generateVariants = useGenerateVariants();
  const selectVariant = useSelectVariant();
  const setImageFromVariant = useSetImageFromVariant();
  const {
    needsBillingSetup: falNeedsBillingSetup,
    showGate: showFalGate,
    gateProps: falGateProps,
    stripeEnabled,
  } = useFalBillingGate();

  const handleCopy = useCallback(
    async (text: string | undefined, tabName: string) => {
      if (!text) return;

      try {
        await navigator.clipboard.writeText(text);
        setCopiedTab(tabName);
        setTimeout(() => setCopiedTab(null), 2000);
      } catch (error) {
        console.error('Failed to copy to clipboard:', error);
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
      console.error('Failed to shorten prompt:', error);
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
      console.error('Failed to regenerate image:', error);

      if (isInsufficientCreditsError(error)) {
        showFalGate();
        void queryClient.invalidateQueries({
          queryKey: [...BILLING_BALANCE_KEY],
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

    try {
      await generateFrameMotionFn({
        data: {
          sequenceId: frame.sequenceId,
          frameId: frame.id,
          model: selectedMotionModel,
          prompt: editedMotionPrompt || undefined,
        },
      });

      // Don't invalidate immediately - let auto-polling pick up server updates
    } catch (error) {
      console.error('Failed to regenerate motion:', error);

      if (isInsufficientCreditsError(error)) {
        showFalGate();
        void queryClient.invalidateQueries({
          queryKey: [...BILLING_BALANCE_KEY],
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
      console.error('Failed to generate scene variants:', error);
      // Error handling is done by the mutation hook
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
        console.error(
          'Failed to select variant:',
          error instanceof Error ? error.message : error
        );
        // Error handling is done by the mutation hook
      }
    },
    [frame, selectVariant]
  );

  const motionPromptData = frame?.metadata?.prompts?.motion;

  // Raw prompt for editing (just motion direction, no dialogue/audio)
  const rawMotionPrompt =
    frame?.motionPrompt || motionPromptData?.fullPrompt || '';

  // Assembled preview: exactly what resolveMotionPrompt produces on the server
  const assembledPrompt = useMemo(() => {
    const promptOverride = editedMotionPrompt || rawMotionPrompt;
    return resolveMotionPrompt(
      {
        motionPrompt: promptOverride || null,
        metadata: frame?.metadata ?? null,
        description: frame?.description ?? null,
      },
      selectedMotionModel || DEFAULT_VIDEO_MODEL
    );
  }, [
    editedMotionPrompt,
    rawMotionPrompt,
    frame?.metadata,
    frame?.description,
    selectedMotionModel,
  ]);

  const motionModel = selectedMotionModel || DEFAULT_VIDEO_MODEL;
  const maxPromptLength = IMAGE_TO_VIDEO_MODELS[motionModel].maxPromptLength;
  const isOverLimit = assembledPrompt.length > maxPromptLength;

  // Sync local state when props change (prev-value refs avoid extra re-renders)
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
      {/* Mobile: Select dropdown */}
      <div className="md:hidden">
        <Select
          value={selectedTab}
          onChange={(value) => {
            if (isValidTabValue(value)) {
              onTabChange(value);
            }
          }}
          options={[
            { value: 'scene-variants', label: 'Variants' },
            { value: 'script', label: 'Script' },
            { value: 'cast', label: 'Cast' },
            { value: 'location', label: 'Location' },
            { value: 'image-prompt', label: 'Image' },
            { value: 'motion-prompt', label: 'Motion' },
          ]}
        />
      </div>

      {/* Desktop: Tab buttons */}
      <TabsList className="hidden md:flex">
        <TabsTrigger value="scene-variants">Variants</TabsTrigger>
        <TabsTrigger value="script">Script</TabsTrigger>
        <TabsTrigger value="cast">Cast</TabsTrigger>
        <TabsTrigger value="location">Location</TabsTrigger>
        <TabsTrigger value="image-prompt">Image</TabsTrigger>
        <TabsTrigger value="motion-prompt">Motion</TabsTrigger>
      </TabsList>

      <TabsContent value="script">
        <PromptTabContent
          text={scriptText}
          isCopied={copiedTab === 'script'}
          onCopy={() => void handleCopy(scriptText, 'script')}
          showDuration={true}
          durationMs={frame?.durationMs}
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
              value={editedImagePrompt || imagePrompt || ''}
              onChange={(e) => setEditedImagePrompt(e.target.value)}
              placeholder={
                isGenerating
                  ? 'Prompt is being generated…'
                  : 'Enter image prompt…'
              }
              className="min-h-[120px] resize-y"
              disabled={isGenerating}
            />
          </div>

          {/* Model selector */}
          <div className="space-y-2">
            <span className="text-sm font-medium">Model</span>
            <ImageModelSelector
              selectedModel={selectedImageModel || imageModel}
              onModelChange={handleImageModelChange}
              disabled={isGenerating}
            />
          </div>

          {/* Shorten button */}
          <Button
            variant="outline"
            onClick={() => void handleShortenPrompt()}
            disabled={
              shortenStatus.loading ||
              isGenerating ||
              !editedImagePrompt ||
              editedImagePrompt.length < 20
            }
            className="w-full"
          >
            {shortenStatus.loading && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {!shortenStatus.loading && <Minimize2 className="mr-2 h-4 w-4" />}
            {shortenStatus.loading ? 'Shortening…' : 'Shorten Prompt'}
          </Button>

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
              value={editedMotionPrompt || rawMotionPrompt}
              onChange={(e) => setEditedMotionPrompt(e.target.value)}
              placeholder={
                isGeneratingMotion
                  ? 'Prompt is being generated…'
                  : 'Enter motion prompt…'
              }
              className="min-h-[120px] resize-y"
              disabled={isGenerating || isGeneratingMotion}
            />
          </div>

          {/* Model selector */}
          <div className="space-y-2">
            <span className="text-sm font-medium">Model</span>
            <MotionModelSelector
              selectedModel={selectedMotionModel || DEFAULT_VIDEO_MODEL}
              onModelChange={setSelectedMotionModel}
              disabled={isGenerating || isGeneratingMotion}
              aspectRatio={aspectRatio}
              styleCategory={styleCategory}
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

          {/* Regenerate button */}
          <Button
            onClick={() => {
              if (falNeedsBillingSetup) {
                showFalGate();
                return;
              }
              void handleRegenerateMotion();
            }}
            disabled={isGenerating || isGeneratingMotion || !frame}
            className="w-full"
          >
            {isGeneratingMotion && (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            )}
            {isGeneratingMotion
              ? 'Generating…'
              : frame?.videoUrl
                ? 'Regenerate Motion'
                : 'Generate Motion'}
          </Button>

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

      <BillingGateDialog {...falGateProps} stripeEnabled={stripeEnabled} />
    </Tabs>
  );
};
