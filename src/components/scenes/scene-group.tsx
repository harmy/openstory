import {
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  safeImageToVideoModel,
  safeTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import type { SceneRow } from '@/lib/db/schema';
import { memo } from 'react';

type SceneGroupProps = {
  scene: SceneRow;
  /** 1-based position in the sequence — scenes are an ordered narrative. */
  sceneNumber: number;
  /** Sequence defaults a scene inherits when its own model column is null. */
  sequenceImageModel: TextToImageModel;
  sequenceVideoModel: ImageToVideoModel;
  /** Shot cards for this scene (rendered by the parent to keep shot plumbing there). */
  children: React.ReactNode;
};

/**
 * A scene and its shots in the list. The scene's look (image) + motion (video)
 * models show here as read-only chips for scannability; they're edited in the
 * detail panel's scene bar (#909).
 */
const SceneGroupComponent: React.FC<SceneGroupProps> = ({
  scene,
  sceneNumber,
  sequenceImageModel,
  sequenceVideoModel,
  children,
}) => {
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

  const title = scene.title?.trim() || `Scene ${sceneNumber}`;
  const context = [scene.location, scene.timeOfDay]
    .filter((v): v is string => !!v && v.trim().length > 0)
    .join(' · ');

  return (
    <div className="rounded-lg border bg-muted/20">
      <div className="flex flex-col gap-1.5 border-b px-3 py-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <div className="flex min-w-0 items-baseline gap-2">
            <span className="shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">
              Scene {sceneNumber}
            </span>
            <span className="truncate text-sm font-medium">{title}</span>
          </div>
          {context && (
            <span className="shrink-0 text-[11px] text-muted-foreground">
              {context}
            </span>
          )}
        </div>
        {imageInherited && videoInherited ? (
          <span className="text-[11px] italic text-muted-foreground/70">
            Inherits sequence models
          </span>
        ) : (
          <span className="text-[11px] text-muted-foreground">
            {IMAGE_MODELS[lookModel].name}
            <span className="px-1 opacity-40">·</span>
            {IMAGE_TO_VIDEO_MODELS[motionModel].name}
          </span>
        )}
      </div>

      <div className="flex flex-col gap-3 p-3">{children}</div>
    </div>
  );
};

export const SceneGroup = memo(SceneGroupComponent);
