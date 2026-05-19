/**
 * Scene Script Tab
 * Edits the scene script extract and duration. Duration options are sourced
 * from the selected motion model's JSON Schema so the user can only pick
 * values the model accepts.
 */

import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MarkdownEditor } from '@/components/ui/markdown-editor';
import { estimateSceneDurationFn } from '@/functions/ai';
import { IMAGE_TO_VIDEO_MODELS, type ImageToVideoModel } from '@/lib/ai/models';
import { MOTION_JSON_SCHEMAS } from '@/lib/motion/endpoint-map';
import { snapDuration } from '@/lib/motion/motion-generation';
import { getDurationValues, numericOf } from '@/lib/motion/motion-transform';
import type { Frame } from '@/types/database';
import { useMutation } from '@tanstack/react-query';
import { CopyIcon, Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';

export type SceneScriptTabSavePayload = {
  nextExtract: string;
  nextDurationSeconds: number | undefined;
};

type SceneScriptTabProps = {
  frame: Frame | undefined;
  sequenceId: string;
  scriptText: string | undefined;
  motionModel: ImageToVideoModel;
  editedScript: string | undefined;
  onEditedScriptChange: (value: string | undefined) => void;
  editedDurationSeconds: number | undefined;
  onEditedDurationChange: (value: number | undefined) => void;
  isSaving: boolean;
  onSave: (payload: SceneScriptTabSavePayload) => void;
  isCopied: boolean;
  onCopy: (text: string) => void;
};

export const SceneScriptTab: React.FC<SceneScriptTabProps> = ({
  frame,
  sequenceId,
  scriptText,
  motionModel,
  editedScript,
  onEditedScriptChange,
  editedDurationSeconds,
  onEditedDurationChange,
  isSaving,
  onSave,
  isCopied,
  onCopy,
}) => {
  const savedScript = scriptText ?? '';
  const currentScript = editedScript ?? savedScript;
  const isScriptDirty =
    editedScript !== undefined && editedScript !== savedScript;

  const savedDurationSeconds =
    frame?.durationMs && frame.durationMs > 0
      ? frame.durationMs / 1000
      : frame?.metadata?.metadata?.durationSeconds;

  // Drive the options off the selected motion model's JSON Schema so the user
  // can only pick a value the model actually accepts. If the saved value isn't
  // in the set (model changed since last save, or legacy data), snapping
  // surfaces a pending edit so Save re-anchors the frame onto a valid duration.
  const durationOptions = getDurationValues(
    MOTION_JSON_SCHEMAS[IMAGE_TO_VIDEO_MODELS[motionModel].id]
  ).map(numericOf);
  const snappedSavedSeconds = snapDuration(savedDurationSeconds, motionModel);
  const isSavedOutOfRange =
    savedDurationSeconds !== undefined &&
    snappedSavedSeconds !== savedDurationSeconds;
  const currentDurationSeconds = editedDurationSeconds ?? snappedSavedSeconds;
  const isDurationDirty =
    editedDurationSeconds !== undefined
      ? editedDurationSeconds !== savedDurationSeconds
      : isSavedOutOfRange;

  const estimateMutation = useMutation({
    mutationFn: async () => {
      if (!frame?.id) throw new Error('frame required');
      if (!currentScript.trim()) throw new Error('script is empty');
      return estimateSceneDurationFn({
        data: {
          sequenceId,
          frameId: frame.id,
          extract: currentScript,
        },
      });
    },
    onSuccess: ({ durationSeconds }) => {
      const snapped = snapDuration(durationSeconds, motionModel);
      onEditedDurationChange(snapped);
      toast.success(`Suggested duration: ${snapped}s`);
    },
    onError: (error) => {
      toast.error('Duration estimate failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

  const isDirty = isScriptDirty || isDurationDirty;
  const isEstimating = estimateMutation.isPending;
  const canSave = isDirty && !!frame?.metadata && !isSaving && !isEstimating;
  const canEstimate =
    !!frame && !!currentScript.trim() && !isSaving && !isEstimating;

  const handleCancel = () => {
    onEditedScriptChange(undefined);
    onEditedDurationChange(undefined);
  };

  const handleSave = () => {
    onSave({
      nextExtract: currentScript,
      nextDurationSeconds: isDurationDirty ? currentDurationSeconds : undefined,
    });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <label htmlFor="script-extract-input" className="text-sm font-medium">
            Scene script
          </label>
          <span className="text-xs text-muted-foreground">
            {currentScript.length} characters
          </span>
        </div>
        <div className="relative">
          <MarkdownEditor
            id="script-extract-input"
            value={currentScript}
            onValueChange={(value) => onEditedScriptChange(value)}
            placeholder="Enter the script text for this scene…"
            className="min-h-[180px] pr-10"
            disabled={!frame || isSaving}
          />
          <Button
            size="icon"
            variant="ghost"
            onClick={() => onCopy(currentScript)}
            disabled={!currentScript}
            aria-label="Copy scene script"
            className="absolute right-1 top-1 h-8 w-8"
          >
            {isCopied ? (
              <span className="text-xs">✓</span>
            ) : (
              <CopyIcon className="h-4 w-4" />
            )}
          </Button>
        </div>
      </div>

      <div className="space-y-2">
        <label htmlFor="scene-duration-input" className="text-sm font-medium">
          Duration (seconds)
        </label>
        <div className="flex items-center gap-2">
          <Select
            value={String(currentDurationSeconds)}
            onValueChange={(value) => onEditedDurationChange(Number(value))}
            disabled={!frame || isSaving || isEstimating}
          >
            <SelectTrigger id="scene-duration-input" className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {durationOptions.map((seconds) => (
                <SelectItem key={seconds} value={String(seconds)}>
                  {seconds}s
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            size="sm"
            variant="outline"
            onClick={() => estimateMutation.mutate()}
            disabled={!canEstimate}
          >
            {isEstimating ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="mr-2 h-4 w-4" />
            )}
            {isEstimating ? 'Estimating…' : 'Estimate'}
          </Button>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          onClick={handleCancel}
          disabled={!isDirty || isSaving}
        >
          Cancel
        </Button>
        <Button size="sm" onClick={handleSave} disabled={!canSave}>
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          {isSaving ? 'Saving…' : 'Save'}
        </Button>
      </div>

      {isDirty && (
        <p className="text-xs text-muted-foreground">
          Saving will mark the image and motion prompts as stale.
        </p>
      )}
    </div>
  );
};
