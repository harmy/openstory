/**
 * ShotWithImage — the API/client shape of a shot with its image surface.
 *
 * The still IMAGE columns moved off `shots` onto the anchor `frame` in #989
 * (a shot is the VIDEO unit, a frame is the IMAGE unit). To keep the client and
 * realtime contract stable — so the UI keeps its current structure (one frame
 * per shot → render the anchor) — server read paths project the anchor frame's
 * `image*` fields back under the legacy `thumbnail*` / `image*` names the UI and
 * cache already read. The raw `frame` is also exposed for callers that want the
 * real shape (version pickers, etc.).
 *
 * `variantImageUrl` / `variantImageStatus` are the 3×3 grid sheet, now a
 * `kind:'framing'` `frame_variants` version rather than a shots column.
 */

import type { Frame, Shot } from '@/lib/db/schema';

export type ShotGridSheet = {
  url: string | null;
  status: Frame['imageStatus'];
};

export type ShotWithImage = Shot & {
  thumbnailUrl: Frame['imageUrl'];
  previewThumbnailUrl: Frame['previewImageUrl'];
  thumbnailPath: Frame['imagePath'];
  thumbnailStatus: Frame['imageStatus'];
  thumbnailWorkflowRunId: Frame['imageWorkflowRunId'];
  thumbnailGeneratedAt: Frame['imageGeneratedAt'];
  thumbnailError: Frame['imageError'];
  imageModel: Frame['imageModel'];
  imagePrompt: Frame['imagePrompt'];
  thumbnailInputHash: Frame['imageInputHash'];
  visualPromptInputHash: Frame['visualPromptInputHash'];
  variantImageUrl: string | null;
  variantImageStatus: Frame['imageStatus'];
  /** The anchor frame, verbatim — for version/variant-aware callers. */
  frame: Frame;
};

/**
 * Project a shot whose anchor frame row is absent. Every shot should own one
 * (migration backfill + `shots.ensureAnchorFrames`), but a batch read that
 * left-joins must not DROP a frameless shot — that would make it vanish from
 * the list. Returns the shot with a null image surface (and a synthetic anchor
 * frame so the shape is uniform).
 */
export function projectShotMissingFrame(shot: Shot): ShotWithImage {
  const frame: Frame = {
    id: shot.id,
    shotId: shot.id,
    sequenceId: shot.sequenceId,
    orderIndex: 0,
    role: 'first',
    source: 'generated',
    imageUrl: null,
    previewImageUrl: null,
    imagePath: null,
    imageStatus: null,
    imageWorkflowRunId: null,
    imageGeneratedAt: null,
    imageError: null,
    // Frozen literal (matches the column default); the real model is stamped
    // when an image is generated.
    imageModel: 'nano_banana_2',
    imagePrompt: null,
    selectedImageVersionId: null,
    selectedImagePromptVersionId: null,
    imageInputHash: null,
    visualPromptInputHash: null,
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
  };
  return projectShotWithImage(shot, frame);
}

export function projectShotWithImage(
  shot: Shot,
  frame: Frame,
  gridSheet?: ShotGridSheet | null
): ShotWithImage {
  return {
    ...shot,
    thumbnailUrl: frame.imageUrl,
    previewThumbnailUrl: frame.previewImageUrl,
    thumbnailPath: frame.imagePath,
    thumbnailStatus: frame.imageStatus,
    thumbnailWorkflowRunId: frame.imageWorkflowRunId,
    thumbnailGeneratedAt: frame.imageGeneratedAt,
    thumbnailError: frame.imageError,
    imageModel: frame.imageModel,
    imagePrompt: frame.imagePrompt,
    thumbnailInputHash: frame.imageInputHash,
    visualPromptInputHash: frame.visualPromptInputHash,
    variantImageUrl: gridSheet?.url ?? null,
    variantImageStatus: gridSheet?.status ?? null,
    frame,
  };
}
