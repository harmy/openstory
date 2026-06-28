import {
  DEFAULT_IMAGE_MODEL,
  IMAGE_MODELS,
  isValidTextToImageModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  computeMotionPromptInputHash,
  computeVisualPromptInputHash,
} from '@/lib/ai/input-hash';
import { loadNarrowShotPromptContext } from '@/lib/ai/prompt-context';
import type { ShotVariant, NewShot } from '@/lib/db/schema';
import {
  projectShotWithImage,
  type ShotGridSheet,
} from '@/lib/shots/shot-with-image';
import { getGenerationChannel } from '@/lib/realtime';
import { getVideoDownloadUrl } from '@/lib/motion/video-storage';
import {
  bulkShotSchema,
  singleShotSchema,
  updateShotSchema,
} from '@/lib/schemas/shot.schemas';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { rescanContinuityFromPrompt } from '@/lib/scenes/rescan-continuity-from-prompt';
import { buildRegenerateShotSnapshot } from '@/lib/workflows/regenerate-shots-snapshot';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import {
  authWithTeamMiddleware,
  shotAccessMiddleware,
  sequenceAccessMiddleware,
} from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'shots']);

const shotIdInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

export const getShotsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const { scopedDb, sequence } = context;
    const shotRows = await scopedDb.shots.listBySequence(sequence.id);
    // Guarantee every shot has its anchor frame, then project the image surface
    // (#989) back under the legacy thumbnail*/image* names so the UI is unchanged.
    await scopedDb.shots.ensureAnchorFrames(shotRows);
    const [anchorRows, gridSheets] = await Promise.all([
      scopedDb.frames.listAnchorsBySequence(sequence.id),
      scopedDb.frameVariants.listLatestGridSheetsBySequence(sequence.id),
    ]);
    const anchorsByShot = new Map(anchorRows.map((f) => [f.shotId, f]));
    return shotRows.flatMap((shot) => {
      const frame = anchorsByShot.get(shot.id);
      if (!frame) return [];
      // Grid sheets are keyed by frame id (#989), resolved from the anchor.
      const sheet = gridSheets.get(frame.id);
      const gridSheet: ShotGridSheet | null = sheet
        ? { url: sheet.url, status: sheet.status }
        : null;
      return [projectShotWithImage(shot, frame, gridSheet)];
    });
  });

/**
 * Batched variant of `getShotsFn` for list-style pages that need shots for
 * many sequences at once. The sequences list page used to fire one
 * `getShotsFn` per row; with 50+ sequences this saturated iOS Chrome's
 * connection pool, queued every subsequent navigation request, and killed
 * the WebProcess (root cause of the "Can't open this page" report).
 *
 * Team scoping is enforced by the join inside `sequences.listShotsByIds`,
 * so caller-supplied ids from another team return nothing rather than leak.
 * `listShotsByIds` chunks the ids to respect D1's bound-parameter limit, so
 * the cap here is only an abuse guard on request size — a team's full sequence
 * list (which the sequences/eval pages send) used to overflow the old 500 cap
 * once it grew past 500 sequences (#957).
 */
export const getShotsForSequencesFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceIds: z.array(ulidSchema).max(5000),
      })
    )
  )
  .handler(async ({ data, context }) => {
    return context.scopedDb.sequences.listShotsByIds(data.sequenceIds);
  });

export const getShotFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .handler(async ({ context }) => {
    const sheet = await context.scopedDb.frameVariants.getLatestGridSheet(
      context.frame.id
    );
    return projectShotWithImage(
      context.shot,
      context.frame,
      sheet ? { url: sheet.url, status: sheet.status } : null
    );
  });

export const getSequenceImageModelsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const models = await context.scopedDb.frameVariants.listModelsForSequence(
      context.sequence.id
    );
    // Preview thumbnails are generated with a hidden internal model
    // (PREVIEW_IMAGE_MODEL = flux_2_turbo) and stored as image variants. Hide
    // such hidden models from the user-facing sequence image-model list — they
    // aren't a real choice and only confuse the header dropdown.
    return models.filter(
      (model) =>
        !(isValidTextToImageModel(model) && 'hidden' in IMAGE_MODELS[model])
    );
  });

export const getSequenceVideoModelsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.shotVariants.listModelsForSequence(
      context.sequence.id,
      'video'
    );
  });

export const getDivergentVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.shotVariants.listDivergentBySequence(
      context.sequence.id
    );
  });

type PromoteProgressEvent = 'video:progress' | 'audio:progress';
type PromoteProgressUrlField = 'videoUrl' | 'audioUrl';

/**
 * Build the per-variantType `shots` update payload and matching realtime
 * progress event metadata for a promote-variant operation. Exported (and
 * pure) for unit testing — the server-fn handler wraps this in auth +
 * persistence.
 *
 * Image promotion is retired (#989): image variants live in `frame_variants`
 * and selection is a pointer repoint via `setImageFromVariantFn` /
 * `frameVariants.select`, not a divergent-alternate promote. This only handles
 * the video/audio variants that still live on `shot_variants`.
 */
export function buildPromoteUpdate(variant: ShotVariant): {
  update: Partial<NewShot>;
  progressEvent: PromoteProgressEvent;
  progressUrlField: PromoteProgressUrlField;
} {
  const update: Partial<NewShot> = {};
  let progressEvent: PromoteProgressEvent;
  let progressUrlField: PromoteProgressUrlField;

  switch (variant.variantType) {
    case 'image':
      throw new Error(
        'Image variants are not promoted — select via frameVariants.select (#989)'
      );
    case 'video':
      update.videoUrl = variant.url;
      update.videoPath = variant.storagePath;
      update.videoStatus = 'completed';
      update.videoError = null;
      update.videoInputHash = variant.inputHash;
      progressEvent = 'video:progress';
      progressUrlField = 'videoUrl';
      break;
    case 'audio':
      update.audioUrl = variant.url;
      update.audioPath = variant.storagePath;
      update.audioStatus = 'completed';
      update.audioError = null;
      update.audioInputHash = variant.inputHash;
      progressEvent = 'audio:progress';
      progressUrlField = 'audioUrl';
      break;
  }

  return { update, progressEvent, progressUrlField };
}

/**
 * Promote a divergent alternate to be the live primary for its variant type.
 * Copies the variant's url/path into the matching shots column, updates the
 * matching `*_input_hash` so the live row reflects the alternate's inputs,
 * soft-deletes the variant, and emits a synthetic `*:progress` event so any
 * listeners refresh.
 */
export const promoteVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shotId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const { shot, scopedDb } = context;
    const variant = await scopedDb.shotVariants.getById(data.variantId);
    if (!variant || variant.shotId !== shot.id) {
      throw new Error('Variant not found for this shot');
    }
    if (variant.divergedAt === null || variant.discardedAt !== null) {
      throw new Error('Variant is not a live divergent alternate');
    }
    if (!variant.url) {
      throw new Error('Variant has no asset to promote');
    }

    const { update, progressEvent, progressUrlField } =
      buildPromoteUpdate(variant);

    // Atomic: a partial failure can't leave the live primary updated with the
    // variant still appearing in the divergent list (or vice versa).
    const { shot: updatedShot } = await scopedDb.shotVariants.promoteAtomically(
      shot.id,
      update,
      variant.id
    );

    // Realtime emit is purely cache-busting — TanStack Query refetches on the
    // mutation onSuccess invalidation regardless. A failed emit must not
    // surface to the user as "promote failed" when the DB already committed.
    const channel = getGenerationChannel(data.sequenceId);
    try {
      const url = updatedShot[progressUrlField] ?? variant.url;
      await channel.emit(
        `generation.${progressEvent}`,
        progressEvent === 'audio:progress'
          ? {
              shotId: shot.id,
              status: 'completed',
              audioUrl: url,
            }
          : {
              shotId: shot.id,
              status: 'completed',
              videoUrl: url,
              model: variant.model,
            }
      );
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }

    return { shot: updatedShot, variantId: variant.id };
  });

export const discardVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shotId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.shotVariants.getById(data.variantId);
    if (!variant || variant.shotId !== context.shot.id) {
      throw new Error('Variant not found for this shot');
    }
    const discardedAt = await context.scopedDb.shotVariants.discard(variant.id);
    return { variantId: variant.id, discardedAt };
  });

export const undiscardVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shotId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.shotVariants.getById(data.variantId);
    if (!variant || variant.shotId !== context.shot.id) {
      throw new Error('Variant not found for this shot');
    }
    await context.scopedDb.shotVariants.undiscard(variant.id);
    return { variantId: variant.id };
  });

export const getSequenceImageVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    // Image variants moved to `frame_variants` (#989). Each row carries its
    // owning `shotId` (frame ids ≠ shot ids) so the client coverage logic keyed
    // by shot keeps working.
    return context.scopedDb.frameVariants.listModelVersionsBySequence(
      context.sequence.id
    );
  });

export const getSequenceVideoVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.shotVariants.listBySequence(
      context.sequence.id,
      'video'
    );
  });

export const createShotFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(singleShotSchema.extend({ sequenceId: ulidSchema }))
  )
  .handler(async ({ data, context }) => {
    return context.scopedDb.shots.create(data);
  });

export const createShotsBulkFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shots: bulkShotSchema.shape.shots,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const shotInserts: NewShot[] = data.shots.map((shot) => ({
      sequenceId: data.sequenceId,
      ...shot,
    }));
    return context.scopedDb.shots.bulkUpsert(shotInserts);
  });

export const updateShotFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(
    zodValidator(
      updateShotSchema.extend({ sequenceId: ulidSchema, shotId: ulidSchema })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequenceId, shotId, ...updateData } = data;

    // Scene-script edits (#684): when `originalScript.extract` changes,
    // clear the parsed dialogue (now stale wrt the new text) and mirror the
    // change into the parent `sequences.script` so script view stays in sync.
    // Prompt-input-hash staleness handles the Image/Motion banners on its
    // own — `originalScript.extract` is part of the hashed scene context, so
    // the next `getShotStalenessFn` call will report `'stale'` without us
    // touching the stored prompt hashes here.
    const oldExtract = context.shot.metadata?.originalScript.extract ?? '';
    const incomingExtract = updateData.metadata?.originalScript.extract;
    const scriptChanged =
      typeof incomingExtract === 'string' && incomingExtract !== oldExtract;
    if (scriptChanged && updateData.metadata) {
      updateData.metadata = {
        ...updateData.metadata,
        originalScript: {
          extract: incomingExtract,
          dialogue: [],
        },
      };

      // Bootstrap missing prompt-input hashes. Shots that were generated
      // before hash tracking landed have `imagePrompt` / `motionPrompt` set
      // but null hashes and no `shot_prompt_variants` rows — so the
      // `getLatestWithInputHash` fallback in `getShotStalenessFn` can't
      // find a reference either, and staleness stays `'untracked'` forever.
      // Compute the hash from the PRE-edit scene and stamp it on the shot
      // now: the post-edit live hash will then differ → banner flips
      // `'stale'`. One-shot per shot; subsequent edits hit the normal hash
      // chain.
      let preEditSequenceForSplice: Awaited<
        ReturnType<typeof context.scopedDb.sequences.getById>
      > | null = null;
      if (context.shot.metadata) {
        // (Visual-prompt-hash bootstrap removed in #989 — the image prompt and
        // its hash live on the anchor frame / `frame_prompt_versions` now, and
        // `getShotStalenessFn` already falls back to
        // `framePromptVersions.getLatestWithInputHash`.)
        if (context.shot.motionPrompt && !context.shot.motionPromptInputHash) {
          try {
            preEditSequenceForSplice ??=
              await context.scopedDb.sequences.getById(sequenceId);
            if (preEditSequenceForSplice) {
              const ctx = await loadNarrowShotPromptContext({
                scopedDb: context.scopedDb,
                sequence: {
                  id: preEditSequenceForSplice.id,
                  styleId: preEditSequenceForSplice.styleId,
                  aspectRatio: preEditSequenceForSplice.aspectRatio,
                  analysisModel: preEditSequenceForSplice.analysisModel,
                },
                scene: context.shot.metadata,
                startingFrameImageUrl: context.frame.imageUrl,
              });
              updateData.motionPromptInputHash =
                await computeMotionPromptInputHash(ctx);
            }
          } catch (err) {
            logger.warn(
              `Could not bootstrap motion hash for shot ${shotId}; staleness will remain untracked for this prompt`,
              { err }
            );
          }
        }
      }

      // Splice the new extract into the parent script. The naive
      // `script.replace(oldExtract, …)` would corrupt the wrong scene
      // whenever an extract appears more than once (recurring slug lines,
      // "CUT TO BLACK.", duplicated cues). Instead, walk every shot in
      // orderIndex order and locate each one's extract sequentially in
      // `seq.script`; the target shot's match is the one we splice.
      // Best-effort: if the walk falls out of sync (e.g. the parent was
      // edited separately), leave the parent untouched — the shot still
      // saves, the scene tab still reflects the new extract, and we avoid
      // injecting into the wrong position. Read-then-write on
      // `sequences.script` is racy under concurrent scene edits; accept
      // that as the worst-case loss of one parent-script update.
      // Reuse the sequence fetched above if the bootstrap path already
      // loaded it.
      const seq =
        preEditSequenceForSplice ??
        (await context.scopedDb.sequences.getById(sequenceId));
      if (seq?.script && oldExtract) {
        const siblings =
          await context.scopedDb.shots.listBySequence(sequenceId);
        let cursor = 0;
        let targetStart = -1;
        let targetLength = 0;
        let walkDiverged = false;
        for (const sibling of siblings) {
          const siblingExtract = sibling.metadata?.originalScript.extract;
          if (!siblingExtract) continue;
          const pos = seq.script.indexOf(siblingExtract, cursor);
          if (pos === -1) {
            walkDiverged = true;
            break;
          }
          if (sibling.id === shotId) {
            targetStart = pos;
            targetLength = siblingExtract.length;
          }
          cursor = pos + siblingExtract.length;
        }
        if (!walkDiverged && targetStart !== -1) {
          await context.scopedDb.sequences.update({
            id: sequenceId,
            script:
              seq.script.slice(0, targetStart) +
              incomingExtract +
              seq.script.slice(targetStart + targetLength),
          });
        } else {
          logger.warn(
            `Parent script walk could not locate shot ${shotId} for sequence ${sequenceId}; skipping parent script sync`
          );
        }
      }
    }

    // When a user edits a prompt, auto-link any element/cast/location tags
    // they mentioned by additively merging them into shot.metadata.continuity
    // so the next generation pulls those references in (#683). Skip when the
    // prompt value hasn't actually changed, so plain saves stay a single
    // UPDATE with no extra reads.
    const imagePromptChanged =
      updateData.imagePrompt !== undefined &&
      updateData.imagePrompt !== context.frame.imagePrompt;
    const motionPromptChanged =
      updateData.motionPrompt !== undefined &&
      updateData.motionPrompt !== context.shot.motionPrompt;
    const shotMetadata = context.shot.metadata;
    if (
      (imagePromptChanged || motionPromptChanged) &&
      shotMetadata?.continuity
    ) {
      const promptText = [
        imagePromptChanged ? updateData.imagePrompt : null,
        motionPromptChanged ? updateData.motionPrompt : null,
      ]
        .filter((s): s is string => typeof s === 'string' && s.length > 0)
        .join('\n');

      const rescan = await rescanContinuityFromPrompt({
        scopedDb: context.scopedDb,
        sequenceId,
        existing: shotMetadata.continuity,
        promptText,
      });

      if (rescan.changed) {
        updateData.metadata = {
          ...shotMetadata,
          continuity: rescan.continuity,
        };
      }
    }

    // The image prompt lives on the anchor frame (#989), not a `shots` column.
    // Persist a changed prompt as a user-edit `frame_prompt_versions` row (which
    // mirrors it onto `frame.imagePrompt` + repoints the pointer), then drop it
    // from the shots UPDATE.
    const { imagePrompt: editedImagePrompt, ...shotUpdate } = updateData;
    if (
      imagePromptChanged &&
      typeof editedImagePrompt === 'string' &&
      editedImagePrompt.length > 0
    ) {
      await context.scopedDb.framePromptVersions.write({
        frameId: context.frame.id,
        text: editedImagePrompt,
        source: 'user-edit',
        inputHash: null,
        analysisModel: null,
        createdBy: context.user.id,
      });
    }

    return context.scopedDb.shots.update(shotId, shotUpdate);
  });

export const deleteShotFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(shotIdInputSchema))
  .handler(async ({ data, context }) => {
    await context.scopedDb.shots.delete(data.shotId);
    return { success: true, sequenceId: data.sequenceId };
  });

export const deleteShotsBySequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    await context.scopedDb.shots.deleteBySequence(context.sequence.id);
    return { success: true };
  });

export const reorderShotsFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        shotOrders: z
          .array(z.object({ id: ulidSchema, orderIndex: z.number().int() }))
          .min(1),
      })
    )
  )
  .handler(async ({ data, context }) => {
    const shotOrders = data.shotOrders.map((f) => ({
      id: f.id,
      order_index: f.orderIndex,
    }));
    await context.scopedDb.shots.reorder(data.sequenceId, shotOrders);
    return { success: true };
  });

/**
 * Returns staleness state for a shot's artifacts. Covers the rendered
 * thumbnail plus the visual / motion prompts (stage 4). Each value is
 * computed by re-deriving the current input hash from live scoped state and
 * comparing it to the stored `*_input_hash` via the scoped helper.
 *
 * Three states per artifact:
 *   - `'stale'`     — stored hash diverges from the freshly computed one.
 *   - `'fresh'`     — stored hash matches.
 *   - `'untracked'` — no stored hash (legacy artifact, or never generated).
 *                     Distinct from `'fresh'` so the UI can suppress the
 *                     regenerate prompt without lying about the artifact's
 *                     freshness.
 */
export const getShotStalenessFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(shotIdInputSchema))
  .handler(async ({ context }) => {
    const { shot, frame, sequence, scopedDb } = context;

    let thumbnail: 'stale' | 'fresh' | 'untracked' = 'untracked';
    // Effective prompt: same fallback chain as `buildRegenerateShotSnapshot`
    // and `generateShotImageFn`. `frame.imagePrompt` alone misses AI-generated
    // shots (where it stays null) and shots whose visual prompt was regenerated
    // (which only updates metadata). The image prompt lives on the anchor frame
    // since #989. See #713.
    const effectivePrompt =
      frame.imagePrompt || shot.metadata?.prompts?.visual?.fullPrompt;
    if (effectivePrompt) {
      // Distinguish "stored hash absent" from "stored hash matches". A null
      // stored hash means the image predates hash tracking (or was generated
      // by a pre-fix `generateShotImageFn` that didn't pass a sceneSnapshot)
      // — we genuinely have no opinion, so 'untracked' rather than lying with
      // 'fresh'. Once the user regenerates the image once under the new code
      // path, this column populates and the live-vs-stored comparison takes
      // over.
      if (frame.imageInputHash === null) {
        thumbnail = 'untracked';
      } else {
        try {
          const [characters, locations, elements] = await Promise.all([
            scopedDb.characters.listWithSheets(sequence.id),
            scopedDb.sequenceLocations.listWithReferences(sequence.id),
            scopedDb.sequenceElements.list(sequence.id),
          ]);

          const snapshot = await buildRegenerateShotSnapshot({
            shot,
            imagePrompt: frame.imagePrompt,
            characters,
            locations,
            elements,
            imageModel: safeTextToImageModel(
              frame.imageModel,
              DEFAULT_IMAGE_MODEL
            ),
            aspectRatio: sequence.aspectRatio,
          });

          thumbnail =
            snapshot.snapshotInputHash !== frame.imageInputHash
              ? 'stale'
              : 'fresh';
        } catch (error) {
          // Mirror the visual/motion branches: a thumbnail-hash failure (e.g.
          // transient D1 read, malformed element/location row) must not throw
          // out of the whole handler — that would null the entire staleness
          // result and silently suppress the visual/motion banners too. Stay
          // 'untracked' (fail-open as 'fresh' would lie about freshness).
          logger.warn(`thumbnail staleness uncomputable for shot ${shot.id}:`, {
            err: error,
          });
        }
      }
    }

    let visualPrompt: 'stale' | 'fresh' | 'untracked' = 'untracked';
    let motionPrompt: 'stale' | 'fresh' | 'untracked' = 'untracked';

    // Reference hash resolution: prefer the cached column on `shots`, but
    // fall back to the most recent variant with a non-null `inputHash` for
    // shots whose cached column was nulled by a pre-fix user-edit. Without
    // the fallback, those shots are stuck at `'untracked'` permanently.
    if (shot.metadata) {
      // Visual prompt history moved to `frame_prompt_versions` (#989); the
      // cached hash mirror lives on the anchor frame.
      let referenceHash = frame.visualPromptInputHash;
      if (!referenceHash) {
        const fallback =
          await scopedDb.framePromptVersions.getLatestWithInputHash(frame.id);
        referenceHash = fallback?.inputHash ?? null;
      }
      if (referenceHash) {
        try {
          const latest = await scopedDb.framePromptVersions.getLatest(frame.id);
          const ctx = await loadNarrowShotPromptContext({
            scopedDb,
            sequence,
            scene: shot.metadata,
            analysisModelOverride: latest?.analysisModel ?? null,
          });
          const liveHash = await computeVisualPromptInputHash(ctx);
          visualPrompt = liveHash !== referenceHash ? 'stale' : 'fresh';
        } catch (error) {
          // Context unavailable (e.g., style deleted mid-flight). Stay
          // 'untracked' — fail-open as 'fresh' would silently lie to the user.
          logger.warn(`visual staleness uncomputable for shot ${shot.id}:`, {
            err: error,
          });
        }
      }
    }

    if (shot.metadata) {
      let referenceHash = shot.motionPromptInputHash;
      if (!referenceHash) {
        const fallback =
          await scopedDb.shotPromptVersions.getLatestWithInputHash(
            shot.id,
            'motion'
          );
        referenceHash = fallback?.inputHash ?? null;
      }
      if (referenceHash) {
        try {
          const latest = await scopedDb.shotPromptVersions.getLatest(
            shot.id,
            'motion'
          );
          const ctx = await loadNarrowShotPromptContext({
            scopedDb,
            sequence,
            scene: shot.metadata,
            analysisModelOverride: latest?.analysisModel ?? null,
            startingFrameImageUrl: frame.imageUrl,
          });
          const liveHash = await computeMotionPromptInputHash(ctx);
          motionPrompt = liveHash !== referenceHash ? 'stale' : 'fresh';
        } catch (error) {
          logger.warn(`motion staleness uncomputable for shot ${shot.id}:`, {
            err: error,
          });
        }
      }
    }

    return { thumbnail, visualPrompt, motionPrompt };
  });

/**
 * Get a signed download URL for a shot's video.
 * Uses Content-Disposition: attachment to force browser download.
 */
export const getShotDownloadUrlFn = createServerFn({ method: 'GET' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(shotIdInputSchema))
  .handler(async ({ context }) => {
    const { shot } = context;

    if (!shot.videoPath) {
      throw new Error('Shot does not have a video');
    }

    const filename =
      shot.videoPath.split('/').pop() || `scene-${shot.id}_openstory.mp4`;

    const downloadUrl = await getVideoDownloadUrl(
      shot.videoPath,
      filename,
      3600
    );

    return { downloadUrl, filename };
  });
