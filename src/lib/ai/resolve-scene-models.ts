/**
 * Scene-level model resolution (#909).
 *
 * Model selection lives at the scene level: a scene has a *look* (image model)
 * and a *motion character* (video model). A scene's column is NULL when it
 * inherits the sequence default. Resolution precedence is always:
 *
 *   scene override → sequence default → app default
 *
 * Callers that also accept an explicit per-request model (e.g. generating a
 * per-shot image variant in a one-off model) should prefer that first, then
 * fall back to these resolvers.
 */

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeImageToVideoModel,
  safeTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';

/** Just the model fields we read — keeps these resolvers easy to unit-test. */
type SceneModelFields = {
  imageModel?: string | null;
  videoModel?: string | null;
};
type SequenceModelFields = {
  imageModel?: string | null;
  videoModel?: string | null;
};

/** Resolve the image model that drives a scene's shots: scene → sequence → default. */
export function resolveSceneImageModel(
  scene: SceneModelFields | null | undefined,
  sequence: SequenceModelFields
): TextToImageModel {
  return safeTextToImageModel(
    scene?.imageModel ?? sequence.imageModel,
    DEFAULT_IMAGE_MODEL
  );
}

/** Resolve the video model that drives a scene's shots: scene → sequence → default. */
export function resolveSceneVideoModel(
  scene: SceneModelFields | null | undefined,
  sequence: SequenceModelFields
): ImageToVideoModel {
  return safeImageToVideoModel(
    scene?.videoModel ?? sequence.videoModel,
    DEFAULT_VIDEO_MODEL
  );
}
