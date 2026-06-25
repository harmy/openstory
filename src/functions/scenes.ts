import {
  isValidImageToVideoModel,
  isValidTextToImageModel,
} from '@/lib/ai/models';
import { dbSceneId, type NewScene } from '@/lib/db/schema';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { sequenceAccessMiddleware } from './middleware';

/** Ordered scenes for a sequence (#909 — the editor groups shots under these). */
export const getScenesFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.scenes.listBySequence(context.sequence.id);
  });

// `null` resets a field back to inheriting the sequence default; omitting a
// field leaves it untouched. A non-null value must be a known model id —
// the type guards narrow the inferred output to the branded model types, so
// `SceneModelInput` carries `TextToImageModel`/`ImageToVideoModel` (not bare
// `string`) and the validation work isn't discarded downstream.
export const sceneModelSchema = z.object({
  sequenceId: ulidSchema,
  sceneId: ulidSchema,
  imageModel: z
    .string()
    .refine(isValidTextToImageModel, { message: 'Unknown image model' })
    .nullable()
    .optional(),
  videoModel: z
    .string()
    .refine(isValidImageToVideoModel, { message: 'Unknown video model' })
    .nullable()
    .optional(),
});

export type SceneModelInput = z.infer<typeof sceneModelSchema>;

/**
 * Guard that the scene exists and belongs to the access-checked sequence —
 * the scene id is caller-supplied, so a mismatch must not write across
 * sequences. Mirrors the precondition helpers in `sequence-variants`.
 */
export function assertSceneOwnedBySequence<T extends { sequenceId: string }>(
  scene: T | null | undefined,
  sequenceId: string
): asserts scene is T {
  if (!scene || scene.sequenceId !== sequenceId) {
    throw new Error('Scene not found for this sequence');
  }
}

/**
 * Build the column patch from validated input. Only fields actually present
 * are written; `null` clears the override back to inheriting the sequence.
 */
export function buildSceneModelPatch(
  data: SceneModelInput
): Pick<NewScene, 'imageModel' | 'videoModel'> {
  const patch: Pick<NewScene, 'imageModel' | 'videoModel'> = {};
  if ('imageModel' in data) patch.imageModel = data.imageModel ?? null;
  if ('videoModel' in data) patch.videoModel = data.videoModel ?? null;
  return patch;
}

/**
 * Set (or clear) a scene's image/video model override (#909). Model selection
 * lives at the scene level — a scene has a *look* (image model) and a *motion
 * character* (video model). Passing `null` for a field resets it to inherit the
 * sequence default.
 */
export const updateSceneModelFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(sceneModelSchema))
  .handler(async ({ data, context }) => {
    const scene = await context.scopedDb.scenes.getById(
      dbSceneId(data.sceneId)
    );
    assertSceneOwnedBySequence(scene, context.sequence.id);
    return context.scopedDb.scenes.update(scene.id, buildSceneModelPatch(data));
  });
