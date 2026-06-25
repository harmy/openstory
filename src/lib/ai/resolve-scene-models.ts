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
  isValidImageToVideoModel,
  isValidTextToImageModel,
  safeImageToVideoModel,
  safeTextToImageModel,
  type ImageToVideoModel,
  type TextToImageModel,
} from '@/lib/ai/models';

/**
 * Just the model fields we read off a scene or sequence row — keeps these
 * resolvers easy to unit-test without a full row. A field is a model-id
 * string, `null` (inherit), or absent.
 */
type ModelFields = {
  imageModel?: string | null;
  videoModel?: string | null;
};

/** Resolve the image model that drives a scene's shots: scene → sequence → default. */
export function resolveSceneImageModel(
  scene: ModelFields | null | undefined,
  sequence: ModelFields
): TextToImageModel {
  // Only inherit from the scene when its override is a *currently valid* model.
  // A scene value that's set but unrecognized (e.g. a model id retired after
  // the scene was saved) falls back to the sequence default, not straight to
  // the app default — otherwise the user's sequence choice is silently skipped.
  const sceneModel = scene?.imageModel;
  return safeTextToImageModel(
    sceneModel && isValidTextToImageModel(sceneModel)
      ? sceneModel
      : sequence.imageModel,
    DEFAULT_IMAGE_MODEL
  );
}

/** Resolve the video model that drives a scene's shots: scene → sequence → default. */
export function resolveSceneVideoModel(
  scene: ModelFields | null | undefined,
  sequence: ModelFields
): ImageToVideoModel {
  // See `resolveSceneImageModel` — a set-but-invalid scene value inherits the
  // sequence default rather than skipping it for the app default.
  const sceneModel = scene?.videoModel;
  return safeImageToVideoModel(
    sceneModel && isValidImageToVideoModel(sceneModel)
      ? sceneModel
      : sequence.videoModel,
    DEFAULT_VIDEO_MODEL
  );
}
