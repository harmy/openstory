import { BillingGateDialog } from '@/components/billing/billing-gate-dialog';
import { GenerateSequenceIcon } from '@/components/icons/generate-sequence-icon';
import { LocationSuggestionSelector } from '@/components/location-library/location-suggestion-selector';
import { GenerationSettings } from '@/components/settings/generation-settings';
import { StyleSelector } from '@/components/style/style-selector';
import { TalentSuggestionSelector } from '@/components/talent/talent-suggestion-selector';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from '@/components/ui/card';
import { Kbd, KbdGroup } from '@/components/ui/kbd';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { enhanceScriptStreamFn } from '@/functions/ai';
import { useAutoScroll } from '@/hooks/use-auto-scroll';
import { useBillingGate } from '@/hooks/use-billing-gate';
import { useGenerationSettings } from '@/hooks/use-generation-settings';
import { useSequenceDraft } from '@/hooks/use-sequence-draft';
import { useCreateSequence } from '@/hooks/use-sequences';
import { useStyles } from '@/hooks/use-styles';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_MUSIC_MODEL,
  DEFAULT_VIDEO_MODEL,
  IMAGE_TO_VIDEO_MODELS,
  safeAudioModel,
  safeImageToVideoModel,
  safeTextToImageModel,
  type AudioModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  isValidAnalysisModelId,
  type AnalysisModelId,
} from '@/lib/ai/models.config';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { cn } from '@/lib/utils';
import type { Sequence } from '@/types/database';
import { usePostHog } from '@posthog/react';
import { Loader2, Sparkles, Square, Undo2 } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { ScriptEditor } from './script-editor';

const SCRIPT_SHORT_THRESHOLD = 1000;

const DURATION_PRESETS = [
  { value: '15', label: '15s', seconds: 15 },
  { value: '30', label: '30s', seconds: 30 },
  { value: '60', label: '1m', seconds: 60 },
  { value: '120', label: '2m', seconds: 120 },
  { value: '180', label: '3m', seconds: 180 },
] as const;

export const ScriptView: FC<{
  teamId?: string;
  sequence?: Sequence;
  flat?: boolean;
  loading?: boolean;
  onSuccess?: (sequenceIds: string[]) => void;
  onCancel?: () => void;
}> = ({ teamId, sequence, loading = false, onSuccess, flat, onCancel }) => {
  // Local content state - undefined until user makes an edit
  const [contentState, setContentState] = useState<{
    script: string | null | undefined;
    styleId: string | null;
  }>({
    script: sequence?.script,
    styleId: sequence?.styleId || null,
  });
  const { script, styleId } = contentState;
  const setScript = (v: string | null | undefined) =>
    setContentState((s) => ({ ...s, script: v }));
  const setStyleId = (v: string | null) =>
    setContentState((s) => ({ ...s, styleId: v }));

  // Load saved settings from localStorage
  const {
    settings: savedSettings,
    isLoaded: settingsLoaded,
    save: saveSettings,
  } = useGenerationSettings();

  // Load draft from localStorage (script, style, talent, location)
  const {
    draft,
    isLoaded: draftLoaded,
    saveDraft,
    clearDraft,
  } = useSequenceDraft();

  // Determine if we're editing an existing sequence
  const isEditing = !!sequence?.id;

  // Initialize with sequence values (if editing) or localStorage defaults (if creating)
  const sequenceAnalysisModels: AnalysisModelId[] = useMemo(() => {
    if (isEditing && sequence?.analysisModel) {
      return isValidAnalysisModelId(sequence.analysisModel)
        ? [sequence.analysisModel]
        : [DEFAULT_ANALYSIS_MODEL];
    }
    return savedSettings.analysisModels;
  }, [isEditing, sequence?.analysisModel, savedSettings.analysisModels]);

  const [genSettings, setGenSettings] = useState<{
    analysisModels: AnalysisModelId[];
    aspectRatio: AspectRatio;
    imageModels: TextToImageModel[];
    motionModel: ImageToVideoModel;
    autoGenerateMotion: boolean;
    musicModel: AudioModel;
    autoGenerateMusic: boolean;
  }>(() => ({
    analysisModels: sequenceAnalysisModels,
    aspectRatio:
      isEditing && sequence?.aspectRatio
        ? sequence.aspectRatio
        : savedSettings.aspectRatio,
    imageModels:
      isEditing && sequence?.imageModel
        ? [safeTextToImageModel(sequence.imageModel, DEFAULT_IMAGE_MODEL)]
        : (savedSettings.imageModels ?? [savedSettings.imageModel]),
    motionModel:
      isEditing && sequence?.videoModel
        ? safeImageToVideoModel(sequence.videoModel, DEFAULT_VIDEO_MODEL)
        : savedSettings.motionModel,
    autoGenerateMotion: isEditing ? false : savedSettings.autoGenerateMotion,
    musicModel:
      isEditing && sequence?.musicModel
        ? safeAudioModel(sequence.musicModel, DEFAULT_MUSIC_MODEL)
        : savedSettings.musicModel,
    autoGenerateMusic: isEditing ? false : savedSettings.autoGenerateMusic,
  }));
  const {
    analysisModels,
    aspectRatio,
    imageModels,
    motionModel,
    autoGenerateMotion,
    musicModel,
    autoGenerateMusic,
  } = genSettings;
  const updateGen = <K extends keyof typeof genSettings>(
    key: K,
    value: (typeof genSettings)[K]
  ) => setGenSettings((s) => ({ ...s, [key]: value }));
  const [selections, setSelections] = useState({
    talentIds: [] as string[],
    locationIds: [] as string[],
  });
  const { talentIds: selectedTalentIds, locationIds: selectedLocationIds } =
    selections;

  const posthog = usePostHog();

  const { data: styles = [], isLoading: isLoadingStyles } = useStyles();

  // Auto-select first style if none selected
  useEffect(() => {
    if (
      !isLoadingStyles &&
      styles.length > 0 &&
      !styleId &&
      !sequence?.styleId
    ) {
      setStyleId(styles[0].id);
    }
  }, [styles, isLoadingStyles, styleId, sequence?.styleId]);

  // Derive style category for motion model filtering
  const styleCategory = useMemo(
    () =>
      styles.find((s) => s.id === (styleId || sequence?.styleId))?.category ??
      undefined,
    [styles, styleId, sequence?.styleId]
  );

  // Sync draft state when creating new sequences (not editing)
  const hasSyncedDraftRef = React.useRef(false);
  useEffect(() => {
    if (isEditing || loading) {
      hasSyncedDraftRef.current = false;
      return;
    }
    if (!draftLoaded) return;
    if (!hasSyncedDraftRef.current && draft.script) {
      setContentState((s) => ({
        script: draft.script,
        styleId: draft.styleId || s.styleId,
      }));
      setSelections((s) => ({
        talentIds:
          draft.selectedTalentIds.length > 0
            ? draft.selectedTalentIds
            : s.talentIds,
        locationIds:
          draft.selectedLocationIds.length > 0
            ? draft.selectedLocationIds
            : s.locationIds,
      }));
      hasSyncedDraftRef.current = true;
    }
  }, [isEditing, loading, draftLoaded, draft]);

  // Sync state with savedSettings when creating new sequences (not when editing)
  // Use a ref to track if we've already synced to avoid loops
  const hasSyncedRef = React.useRef(false);
  useEffect(() => {
    // Reset sync flag when switching modes
    if (isEditing) {
      hasSyncedRef.current = false;
      return;
    }
    // Wait for localStorage to load before syncing
    if (!settingsLoaded) {
      return;
    }
    // Sync once when creating new sequence
    if (!hasSyncedRef.current) {
      setGenSettings({
        aspectRatio: savedSettings.aspectRatio,
        analysisModels: savedSettings.analysisModels,
        imageModels: savedSettings.imageModels ?? [savedSettings.imageModel],
        motionModel: savedSettings.motionModel,
        autoGenerateMotion: savedSettings.autoGenerateMotion,
        musicModel: savedSettings.musicModel,
        autoGenerateMusic: savedSettings.autoGenerateMusic,
      });
      hasSyncedRef.current = true;
    }
  }, [isEditing, settingsLoaded, savedSettings]);

  // Persist settings to localStorage when creating new sequences (not when editing)
  // Only save after initial load to prevent overwriting with defaults
  useEffect(() => {
    if (!isEditing && settingsLoaded) {
      saveSettings(genSettings);
    }
  }, [isEditing, settingsLoaded, genSettings, saveSettings]);

  // Persist draft to localStorage when creating new sequences
  useEffect(() => {
    if (!isEditing && draftLoaded) {
      saveDraft({
        script: script ?? '',
        styleId,
        selectedTalentIds,
        selectedLocationIds,
      });
    }
  }, [
    isEditing,
    draftLoaded,
    script,
    styleId,
    selectedTalentIds,
    selectedLocationIds,
    saveDraft,
  ]);

  // Auto-fallback motion model when style changes away from a required category
  useEffect(() => {
    const model = IMAGE_TO_VIDEO_MODELS[motionModel];
    if (
      'requiredStyleCategory' in model &&
      model.requiredStyleCategory !== styleCategory
    ) {
      updateGen('motionModel', DEFAULT_VIDEO_MODEL);
    }
  }, [styleCategory, motionModel]);

  const [targetDuration, setTargetDuration] = useState(30);
  const [enhancePopoverOpen, setEnhancePopoverOpen] = useState(false);

  const [enhanceUI, setEnhanceUI] = useState({
    isEnhancing: false,
    error: null as string | null,
    showRegenerateConfirm: false,
    showEnhanceNudge: false,
    canUndoEnhance: false,
  });
  const {
    isEnhancing,
    error: enhanceError,
    showRegenerateConfirm,
    showEnhanceNudge,
    canUndoEnhance,
  } = enhanceUI;
  const setEnhance = <K extends keyof typeof enhanceUI>(
    key: K,
    value: (typeof enhanceUI)[K]
  ) => setEnhanceUI((s) => ({ ...s, [key]: value }));

  const createSequenceMutation = useCreateSequence();
  const {
    needsBillingSetup,
    showGate,
    gateProps,
    hasFalKey,
    hasOpenRouterKey,
    hasCredits,
    stripeEnabled,
  } = useBillingGate();

  const handleCancel = onCancel;

  const executeRegeneration = () => {
    posthog.capture('sequence_generated', {
      is_editing: isEditing,
      aspect_ratio: aspectRatio,
      image_models: imageModels,
      motion_model: motionModel,
      auto_generate_motion: autoGenerateMotion,
      auto_generate_music: autoGenerateMusic,
      analysis_model_count: analysisModels.length,
      script_length: (script ?? sequence?.script ?? '').length,
    });
    createSequenceMutation.mutate(
      {
        title: undefined,
        teamId,
        script: script ?? sequence?.script ?? '',
        styleId: styleId || sequence?.styleId || undefined,
        aspectRatio,
        analysisModels,
        imageModels,
        videoModel: motionModel,
        autoGenerateMotion,
        autoGenerateMusic,
        musicModel,
        suggestedTalentIds:
          selectedTalentIds.length > 0 ? selectedTalentIds : undefined,
        suggestedLocationIds:
          selectedLocationIds.length > 0 ? selectedLocationIds : undefined,
      },
      {
        onSuccess: (result) => {
          clearDraft();
          if (onSuccess) {
            onSuccess(result.data.map((seq) => seq.id));
          }
        },
      }
    );
  };

  const handleSubmit = async (event?: React.FormEvent<HTMLFormElement>) => {
    if (event) {
      event.preventDefault();
    }

    if (needsBillingSetup) {
      showGate();
      return;
    }

    if (isEditing) {
      setEnhance('showRegenerateConfirm', true);
      return;
    }

    const scriptText = script ?? sequence?.script ?? '';
    if (scriptText.length < SCRIPT_SHORT_THRESHOLD) {
      setEnhance('showEnhanceNudge', true);
      return;
    }

    executeRegeneration();
  };

  const previousScriptRef = useRef<string>('');
  const enhanceAbortRef = useRef<AbortController | null>(null);

  const handleEnhance = async () => {
    if (needsBillingSetup) {
      showGate();
      return;
    }

    posthog.capture('script_enhanced', {
      target_duration: targetDuration,
      script_length: scriptValue.length,
      aspect_ratio: aspectRatio,
    });
    setEnhanceUI((s) => ({ ...s, isEnhancing: true, error: null }));
    previousScriptRef.current = scriptValue;
    setScript('');

    const abortController = new AbortController();
    enhanceAbortRef.current = abortController;

    try {
      const selectedStyle = styles.find((s) => s.id === styleId);
      let accumulated = '';
      for await (const chunk of await enhanceScriptStreamFn({
        data: {
          script: scriptValue,
          targetDuration,
          styleConfig: selectedStyle?.config ?? undefined,
          analysisModel: analysisModels[0],
          aspectRatio,
        },
      })) {
        if (abortController.signal.aborted) break;
        accumulated += chunk.delta;
        setScript(accumulated);
      }
      setEnhance('canUndoEnhance', true);
    } catch (error) {
      if (!abortController.signal.aborted) {
        setEnhance(
          'error',
          error instanceof Error ? error.message : 'Failed to enhance script'
        );
        setScript(previousScriptRef.current);
      }
    } finally {
      enhanceAbortRef.current = null;
      setEnhance('isEnhancing', false);
    }
  };

  const handleStopEnhance = () => {
    enhanceAbortRef.current?.abort();
  };

  const handleUndoEnhance = () => {
    setScript(previousScriptRef.current);
    setEnhance('canUndoEnhance', false);
  };

  useEffect(() => {
    if (!isEnhancing) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || (e.metaKey && e.key === '.')) {
        e.preventDefault();
        handleStopEnhance();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isEnhancing]);

  const isFormValid =
    (script || sequence?.script) &&
    (styleId || sequence?.styleId) &&
    analysisModels.length > 0;

  const isSubmitting = createSequenceMutation.isPending;
  const isProcessing = sequence?.status === 'processing';
  const isDisabled =
    !isFormValid || isSubmitting || isProcessing || isEnhancing;

  const scriptValue = script ?? sequence?.script ?? '';
  const { ref: textareaRef } = useAutoScroll({
    enabled: isEnhancing,
    content: scriptValue,
  });

  return (
    <Card
      variant="premium"
      className={cn('flex flex-col min-h-0 max-h-full', flat && 'border-none')}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        className="flex flex-col min-h-0 max-h-full"
      >
        {/* Control bar */}
        <CardHeader className="shrink-0 flex flex-col md:flex-row items-start justify-between gap-3 px-6 py-4 border-b border-border/50 bg-card/40">
          <GenerationSettings
            aspectRatio={aspectRatio}
            analysisModels={analysisModels}
            imageModels={imageModels}
            motionModel={motionModel}
            autoGenerateMotion={autoGenerateMotion}
            musicModel={musicModel}
            autoGenerateMusic={autoGenerateMusic}
            onAspectRatioChange={(v) => updateGen('aspectRatio', v)}
            onAnalysisModelsChange={(v) => updateGen('analysisModels', v)}
            onImageModelsChange={(v) => updateGen('imageModels', v)}
            onMotionModelChange={(v) => updateGen('motionModel', v)}
            onAutoGenerateMotionChange={(v) =>
              updateGen('autoGenerateMotion', v)
            }
            onMusicModelChange={(v) => updateGen('musicModel', v)}
            onAutoGenerateMusicChange={(v) => updateGen('autoGenerateMusic', v)}
            disabled={loading}
            styleCategory={styleCategory}
          />
          <div className="flex items-center gap-2">
            {selectedTalentIds.length === 0 &&
              selectedLocationIds.length === 0 && (
                <span className="text-[10px] text-muted-foreground/40 mr-0.5">
                  optional
                </span>
              )}
            <TalentSuggestionSelector
              selectedTalentIds={selectedTalentIds}
              onSelectionChange={(v) =>
                setSelections((s) => ({ ...s, talentIds: v }))
              }
              disabled={loading}
            />
            <LocationSuggestionSelector
              selectedLocationIds={selectedLocationIds}
              onSelectionChange={(v) =>
                setSelections((s) => ({ ...s, locationIds: v }))
              }
              disabled={loading}
            />
          </div>
        </CardHeader>

        <CardContent className="min-h-0 @container flex flex-col gap-4 py-6 overflow-hidden">
          <div className="relative min-h-0 flex flex-col">
            <ScriptEditor
              ref={textareaRef}
              value={scriptValue}
              onValueChange={(val) => {
                setScript(val);
                if (canUndoEnhance) setEnhance('canUndoEnhance', false);
              }}
              maxLength={50000}
              placeholder="A one-liner or website URL is all you need — click Enhance Script to do the rest. Or paste a full screenplay and generate directly."
              disabled={loading}
              showCharacterCount={false}
            />
            <div className="absolute bottom-2 right-2 flex items-center gap-1">
              {canUndoEnhance && !isEnhancing && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground"
                  onClick={handleUndoEnhance}
                >
                  <Undo2 className="size-3.5" />
                  Undo
                </Button>
              )}
              {isEnhancing ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="gap-1.5 text-muted-foreground"
                  onClick={handleStopEnhance}
                >
                  <span className="relative size-5">
                    <Loader2 className="absolute inset-0 size-5 animate-spin" />
                    <Square className="absolute inset-[5px] size-[10px] fill-current" />
                  </span>
                  Stop
                </Button>
              ) : (
                <Popover
                  open={enhancePopoverOpen}
                  onOpenChange={setEnhancePopoverOpen}
                >
                  <PopoverTrigger asChild>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="gap-1.5 text-muted-foreground"
                      disabled={
                        !scriptValue ||
                        scriptValue.length < 10 ||
                        isSubmitting ||
                        isProcessing
                      }
                    >
                      <Sparkles className="size-3.5" />
                      Enhance Script
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="end" side="top" className="w-auto">
                    <div className="flex flex-col gap-3">
                      <p className="text-sm font-medium">
                        Target video duration
                      </p>
                      <ToggleGroup
                        type="single"
                        value={String(targetDuration)}
                        onValueChange={(v) => {
                          if (v) setTargetDuration(Number(v));
                        }}
                        variant="outline"
                        size="sm"
                      >
                        {DURATION_PRESETS.map((preset) => (
                          <ToggleGroupItem
                            key={preset.value}
                            value={preset.value}
                          >
                            {preset.label}
                          </ToggleGroupItem>
                        ))}
                      </ToggleGroup>
                      <Button
                        type="button"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => {
                          setEnhancePopoverOpen(false);
                          void handleEnhance();
                        }}
                      >
                        <Sparkles className="size-3.5" />
                        Enhance
                      </Button>
                    </div>
                  </PopoverContent>
                </Popover>
              )}
            </div>
          </div>
          {enhanceError && (
            <p className="text-sm text-destructive">{enhanceError}</p>
          )}

          <div className="shrink-0">
            <StyleSelector
              styles={styles}
              selectedStyleId={styleId || sequence?.styleId || null}
              onStyleSelect={setStyleId}
              loading={isLoadingStyles}
            />
          </div>
        </CardContent>

        <CardFooter className="shrink-0 flex-col gap-4 border-t py-4 border-border/30">
          {/* Footer row - stacks on mobile, inline on desktop */}
          <div className="flex w-full flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            {/* Meta info - hidden on mobile */}
            <div className="hidden sm:flex items-center gap-4">
              <span className="text-xs text-muted-foreground flex items-center gap-1">
                <KbdGroup>
                  <Kbd>⌘</Kbd>
                  <span className="text-muted-foreground">+</span>
                  <Kbd>⏎</Kbd>
                </KbdGroup>
                <span className="ml-1">to generate</span>
              </span>
            </div>

            {/* Action buttons */}
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 w-full sm:w-auto">
              <span className="hidden sm:block text-xs text-muted-foreground">
                {analysisModels.length === 1
                  ? '1 sequence will be created'
                  : `${analysisModels.length} sequences will be created`}
              </span>
              {sequence?.id && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={handleCancel}
                >
                  Cancel
                </Button>
              )}
              <Button
                type="submit"
                disabled={isDisabled}
                className="group relative px-6 bg-linear-to-r from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 text-primary-foreground font-semibold tracking-wide shadow-lg shadow-primary/20 hover:shadow-primary/30 overflow-hidden"
              >
                <span className="relative z-10 flex items-center justify-center gap-2">
                  <GenerateSequenceIcon className="size-4" />
                  {sequence?.id ? 'Regenerate Sequence' : 'Generate Sequence'}
                </span>
                {/* Shine effect */}
                <div className="absolute inset-0 bg-linear-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700 pointer-events-none" />
              </Button>
            </div>
          </div>
        </CardFooter>
      </form>
      <BillingGateDialog
        {...gateProps}
        hasFalKey={hasFalKey}
        hasOpenRouterKey={hasOpenRouterKey}
        hasCredits={hasCredits}
        stripeEnabled={stripeEnabled}
      />
      <AlertDialog
        open={showRegenerateConfirm}
        onOpenChange={(v) => setEnhance('showRegenerateConfirm', v)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate sequence?</AlertDialogTitle>
            <AlertDialogDescription>
              A new sequence will be created from this script.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setEnhance('showRegenerateConfirm', false);
                executeRegeneration();
              }}
            >
              Regenerate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={showEnhanceNudge}
        onOpenChange={(v) => setEnhance('showEnhanceNudge', v)}
      >
        <AlertDialogContent
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.stopPropagation();
              setEnhance('showEnhanceNudge', false);
              void handleEnhance();
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>
              Your script is just a starting point
            </AlertDialogTitle>
            <AlertDialogDescription>
              Short scripts produce simpler sequences. Enhance your script to
              create a detailed screenplay with visual descriptions, camera
              directions, and scene breakdowns — tailored to your selected
              style.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex flex-col gap-2 py-2">
            <p className="text-sm font-medium">Target video duration</p>
            <ToggleGroup
              type="single"
              value={String(targetDuration)}
              onValueChange={(v) => {
                if (v) setTargetDuration(Number(v));
              }}
              variant="outline"
              size="sm"
            >
              {DURATION_PRESETS.map((preset) => (
                <ToggleGroupItem key={preset.value} value={preset.value}>
                  {preset.label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <div className="flex-1" />
            <AlertDialogAction
              className={buttonVariants({ variant: 'secondary' })}
              onClick={() => {
                setEnhance('showEnhanceNudge', false);
                executeRegeneration();
              }}
            >
              Generate As-Is
            </AlertDialogAction>
            <AlertDialogAction
              onClick={() => {
                setEnhance('showEnhanceNudge', false);
                void handleEnhance();
              }}
            >
              <Sparkles className="size-3.5" />
              Enhance Script
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
};
