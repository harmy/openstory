import { computeMotionPromptInputHash } from '@/lib/ai/input-hash';
import {
  isValidImageToVideoModel,
  isValidTextToImageModel,
} from '@/lib/ai/models';
import { loadNarrowShotPromptContext } from '@/lib/ai/prompt-context';
import { dbSceneId, type NewScene } from '@/lib/db/schema';
import {
  composeSequenceScriptFromDb,
  projectShotForClient,
} from '@/lib/scenes/scene-script';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { sequenceAccessMiddleware, shotAccessMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'scenes']);

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

/** Composed sequence script from selected scene versions (#1030). */
export const getComposedScriptFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const composed = await composeSequenceScriptFromDb(
      context.scopedDb,
      context.sequence.id
    );
    return { script: composed };
  });

const updateSceneScriptSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  extract: z.string(),
  durationSeconds: z.number().positive().optional(),
});

/**
 * Edit a scene's script by appending a `scene_script_versions` row and
 * repointing `selectedScriptVersionId` (#1030). Prompt-input-hash staleness
 * picks up the new `originalScript` automatically; no sequence fork.
 */
export const updateSceneScriptFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(updateSceneScriptSchema))
  .handler(async ({ data, context }) => {
    const { shot, frame, sequence, scopedDb, user, scene, script } = context;
    if (!shot.sceneId || !scene) {
      throw new Error('Shot is not linked to a scene with metadata');
    }

    const sceneId = dbSceneId(shot.sceneId);
    const selected = await scopedDb.sceneScriptVersions.getSelected(sceneId);
    const currentScript = selected?.content ?? script ?? scene.originalScript;
    const oldExtract = currentScript.extract;
    const scriptChanged = data.extract !== oldExtract;

    if (scriptChanged) {
      await scopedDb.sceneScriptVersions.write({
        sceneId,
        content: {
          ...currentScript,
          extract: data.extract,
          dialogue: [],
        },
        source: 'edit',
        createdBy: user.id,
      });

      // Bootstrap a missing motion prompt hash from the pre-edit scene so
      // staleness can flip to 'stale' on the next read (#684 parity).
      if (shot.motionPrompt && !shot.motionPromptInputHash) {
        try {
          const ctx = await loadNarrowShotPromptContext({
            scopedDb,
            sequence: {
              id: sequence.id,
              styleId: sequence.styleId,
              aspectRatio: sequence.aspectRatio,
              analysisModel: sequence.analysisModel,
            },
            scene,
            startingFrameImageUrl: frame.imageUrl,
          });
          await scopedDb.shots.update(shot.id, {
            motionPromptInputHash: await computeMotionPromptInputHash(ctx),
          });
        } catch (err) {
          logger.warn(
            `Could not bootstrap motion hash for shot ${shot.id}; staleness will remain untracked for this prompt`,
            { err }
          );
        }
      }
    }

    const shotPatch: Parameters<typeof scopedDb.shots.update>[1] = {};
    if (data.durationSeconds !== undefined) {
      shotPatch.durationMs = Math.round(data.durationSeconds * 1000);
      shotPatch.metadata = {
        ...scene,
        metadata: {
          ...(scene.metadata ?? {
            title: '',
            location: '',
            timeOfDay: '',
            storyBeat: '',
          }),
          durationSeconds: data.durationSeconds,
        },
      };
    }

    const updatedShot =
      Object.keys(shotPatch).length > 0
        ? ((await scopedDb.shots.update(shot.id, shotPatch)) ?? shot)
        : shot;

    const refreshedScript =
      (await scopedDb.sceneScriptVersions.getSelected(sceneId))?.content ??
      currentScript;

    return projectShotForClient(updatedShot, refreshedScript);
  });
