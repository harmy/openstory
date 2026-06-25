import { type ModelGenerationStatus } from '@/components/model/base-model-selector';
import { ImageModelSelector } from '@/components/model/image-model-selector';
import { MotionModelSelector } from '@/components/model/motion-model-selector';
import { Button } from '@/components/ui/button';
import { useUpdateSceneModel } from '@/hooks/use-scenes';
import {
  IMAGE_MODELS,
  safeImageToVideoModel,
  safeTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type { SceneRow } from '@/lib/db/schema';

type SceneModelBarProps = {
  /** The selected shot's parent scene; nothing renders without one. */
  scene?: SceneRow;
  /** 1-based position in the sequence, for the heading. */
  sceneNumber?: number;
  sequenceId: string;
  /** Sequence defaults a scene inherits when its own model column is null. */
  sequenceImageModel: TextToImageModel;
  sequenceVideoModel: ImageToVideoModel;
  aspectRatio?: AspectRatio;
  styleCategory?: string;
  styleName?: string;
  recommendedImageModel?: string | null;
  recommendedVideoModel?: string | null;
  /** Per-model ✓/⟳/! markers across the scene's shots (which models generated). */
  imageGeneratedStatuses?: Map<string, ModelGenerationStatus>;
  videoGeneratedStatuses?: Map<string, ModelGenerationStatus>;
};

/**
 * Scene-level model selection for the detail panel (#909). A scene has a *look*
 * (image model) and a *motion character* (video model) shared by all its shots.
 * One editable pair, scoped to the selected scene, so the list stays clean.
 */
export const SceneModelBar: React.FC<SceneModelBarProps> = ({
  scene,
  sceneNumber,
  sequenceId,
  sequenceImageModel,
  sequenceVideoModel,
  aspectRatio,
  styleCategory,
  styleName,
  recommendedImageModel,
  recommendedVideoModel,
  imageGeneratedStatuses,
  videoGeneratedStatuses,
}) => {
  const updateModel = useUpdateSceneModel();
  if (!scene) return null;

  const imageInherited = scene.imageModel == null;
  const videoInherited = scene.videoModel == null;
  const lookModel = safeTextToImageModel(
    scene.imageModel ?? sequenceImageModel,
    sequenceImageModel
  );
  const motionModel = safeImageToVideoModel(
    scene.videoModel ?? sequenceVideoModel,
    sequenceVideoModel
  );

  const setLook = (model: TextToImageModel | null) =>
    updateModel.mutate({ sequenceId, sceneId: scene.id, imageModel: model });
  const setMotion = (model: ImageToVideoModel | null) =>
    updateModel.mutate({ sequenceId, sceneId: scene.id, videoModel: model });

  const title = scene.title?.trim() || `Scene ${sceneNumber ?? ''}`.trim();
  const context = [scene.location, scene.timeOfDay]
    .filter((v): v is string => !!v && v.trim().length > 0)
    .join(' · ');

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border bg-muted/20 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="flex min-w-0 items-baseline gap-2">
          {sceneNumber != null && (
            <span className="shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
              Scene {sceneNumber}
            </span>
          )}
          <span className="truncate text-sm font-medium">{title}</span>
        </div>
        {context && (
          <span className="shrink-0 text-[11px] text-muted-foreground">
            {context}
          </span>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SceneModelField
          label="Look"
          valueLabel={IMAGE_MODELS[lookModel].name}
          inherited={imageInherited}
          disabled={updateModel.isPending}
          onReset={() => setLook(null)}
        >
          <ImageModelSelector
            selectedModel={lookModel}
            onModelChange={(m) => setLook(m)}
            disabled={updateModel.isPending}
            recommendedImageModel={recommendedImageModel}
            styleName={styleName}
            generatedStatuses={imageGeneratedStatuses}
          />
        </SceneModelField>

        <SceneModelField
          label="Motion"
          inherited={videoInherited}
          disabled={updateModel.isPending}
          onReset={() => setMotion(null)}
        >
          <MotionModelSelector
            selectedModel={motionModel}
            onModelChange={(m) => setMotion(m)}
            disabled={updateModel.isPending}
            aspectRatio={aspectRatio}
            styleCategory={styleCategory}
            recommendedVideoModel={recommendedVideoModel}
            generatedStatuses={videoGeneratedStatuses}
          />
        </SceneModelField>
      </div>
    </div>
  );
};

type SceneModelFieldProps = {
  label: string;
  /** Resolved model name (for the inherit tooltip). */
  valueLabel?: string;
  inherited: boolean;
  disabled?: boolean;
  onReset: () => void;
  children: React.ReactNode;
};

/** Label row for a scene model selector — surfaces inherit/override state. */
const SceneModelField: React.FC<SceneModelFieldProps> = ({
  label,
  valueLabel,
  inherited,
  disabled,
  onReset,
  children,
}) => (
  <div className="flex flex-col gap-1">
    <div className="flex items-center justify-between gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {inherited ? (
        <span
          className="text-[10px] text-muted-foreground"
          title={
            valueLabel
              ? `Inherits the sequence default (${valueLabel})`
              : 'Inherits the sequence default'
          }
        >
          Inherits
        </span>
      ) : (
        <Button
          type="button"
          variant="link"
          className="h-auto p-0 text-[10px] text-muted-foreground"
          disabled={disabled}
          onClick={onReset}
        >
          Reset
        </Button>
      )}
    </div>
    {children}
  </div>
);
