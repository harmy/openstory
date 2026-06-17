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
import { loadNarrowFramePromptContext } from '@/lib/ai/prompt-context';
import type { FrameVariant, NewFrame } from '@/lib/db/schema';
import { getGenerationChannel } from '@/lib/realtime';
import { getVideoDownloadUrl } from '@/lib/motion/video-storage';
import {
  bulkFrameSchema,
  singleFrameSchema,
  updateFrameSchema,
} from '@/lib/schemas/frame.schemas';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { rescanContinuityFromPrompt } from '@/lib/scenes/rescan-continuity-from-prompt';
import { buildRegenerateFrameSnapshot } from '@/lib/workflows/regenerate-frames-snapshot';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { frameAccessMiddleware, sequenceAccessMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'frames']);

const frameIdInputSchema = z.object({
  sequenceId: ulidSchema,
  frameId: ulidSchema,
});

export const getFramesFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.frames.listBySequence(context.sequence.id);
  });

export const getFrameFn = createServerFn({ method: 'GET' })
  .middleware([frameAccessMiddleware])
  .handler(async ({ context }) => {
    return context.frame;
  });

export const getSequenceImageModelsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const models = await context.scopedDb.frameVariants.listModelsForSequence(
      context.sequence.id,
      'image'
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
    return context.scopedDb.frameVariants.listModelsForSequence(
      context.sequence.id,
      'video'
    );
  });

export const getDivergentVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.frameVariants.listDivergentBySequence(
      context.sequence.id
    );
  });

type PromoteProgressEvent =
  | 'image:progress'
  | 'video:progress'
  | 'audio:progress';
type PromoteProgressUrlField = 'thumbnailUrl' | 'videoUrl' | 'audioUrl';

/**
 * Build the per-variantType `frames` update payload and matching realtime
 * progress event metadata for a promote-variant operation. Exported (and
 * pure) for unit testing — the server-fn handler wraps this in auth +
 * persistence.
 */
export function buildPromoteUpdate(variant: FrameVariant): {
  update: Partial<NewFrame>;
  progressEvent: PromoteProgressEvent;
  progressUrlField: PromoteProgressUrlField;
} {
  const update: Partial<NewFrame> = {};
  let progressEvent: PromoteProgressEvent;
  let progressUrlField: PromoteProgressUrlField;

  switch (variant.variantType) {
    case 'image':
      update.thumbnailUrl = variant.url;
      update.thumbnailPath = variant.storagePath;
      update.thumbnailStatus = 'completed';
      update.thumbnailError = null;
      update.thumbnailInputHash = variant.inputHash;
      update.imageModel = variant.model;
      // Downstream video is now misaligned with the new image — mark stale
      // by clearing it; the user will regenerate.
      update.videoUrl = null;
      update.videoPath = null;
      update.videoStatus = 'pending';
      update.videoWorkflowRunId = null;
      update.videoGeneratedAt = null;
      update.videoError = null;
      progressEvent = 'image:progress';
      progressUrlField = 'thumbnailUrl';
      break;
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
 * Copies the variant's url/path into the matching frames column, updates the
 * matching `*_input_hash` so the live row reflects the alternate's inputs,
 * soft-deletes the variant, and emits a synthetic `*:progress` event so any
 * listeners refresh.
 */
export const promoteVariantFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        frameId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const { frame, scopedDb } = context;
    const variant = await scopedDb.frameVariants.getById(data.variantId);
    if (!variant || variant.frameId !== frame.id) {
      throw new Error('Variant not found for this frame');
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
    const { frame: updatedFrame } =
      await scopedDb.frameVariants.promoteAtomically(
        frame.id,
        update,
        variant.id
      );

    // Realtime emit is purely cache-busting — TanStack Query refetches on the
    // mutation onSuccess invalidation regardless. A failed emit must not
    // surface to the user as "promote failed" when the DB already committed.
    const channel = getGenerationChannel(data.sequenceId);
    try {
      const url = updatedFrame[progressUrlField] ?? variant.url;
      await channel.emit(
        `generation.${progressEvent}`,
        progressEvent === 'audio:progress'
          ? {
              frameId: frame.id,
              status: 'completed',
              audioUrl: url,
            }
          : progressEvent === 'video:progress'
            ? {
                frameId: frame.id,
                status: 'completed',
                videoUrl: url,
                model: variant.model,
              }
            : {
                frameId: frame.id,
                status: 'completed',
                thumbnailUrl: url,
                model: variant.model,
              }
      );
      // Promoting an image clears the downstream video — emit a paired
      // video:progress event so listeners deriving motion-banner state from
      // realtime (not just cache) reset immediately.
      if (variant.variantType === 'image') {
        await channel.emit('generation.video:progress', {
          frameId: frame.id,
          status: 'pending',
          videoUrl: undefined,
        });
      }
    } catch (error) {
      logger.error('realtime emit failed', { err: error });
    }

    return { frame: updatedFrame, variantId: variant.id };
  });

export const discardVariantFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        frameId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.frameVariants.getById(
      data.variantId
    );
    if (!variant || variant.frameId !== context.frame.id) {
      throw new Error('Variant not found for this frame');
    }
    const discardedAt = await context.scopedDb.frameVariants.discard(
      variant.id
    );
    return { variantId: variant.id, discardedAt };
  });

export const undiscardVariantFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        frameId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.frameVariants.getById(
      data.variantId
    );
    if (!variant || variant.frameId !== context.frame.id) {
      throw new Error('Variant not found for this frame');
    }
    await context.scopedDb.frameVariants.undiscard(variant.id);
    return { variantId: variant.id };
  });

export const getSequenceImageVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.frameVariants.listBySequence(
      context.sequence.id,
      'image'
    );
  });

export const getSequenceVideoVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.frameVariants.listBySequence(
      context.sequence.id,
      'video'
    );
  });

export const createFrameFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(singleFrameSchema.extend({ sequenceId: ulidSchema }))
  )
  .handler(async ({ data, context }) => {
    return context.scopedDb.frames.create(data);
  });

export const createFramesBulkFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        frames: bulkFrameSchema.shape.frames,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const frameInserts: NewFrame[] = data.frames.map((frame) => ({
      sequenceId: data.sequenceId,
      ...frame,
    }));
    return context.scopedDb.frames.bulkUpsert(frameInserts);
  });

export const updateFrameFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(
    zodValidator(
      updateFrameSchema.extend({ sequenceId: ulidSchema, frameId: ulidSchema })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequenceId, frameId, ...updateData } = data;

    // Scene-script edits (#684): when `originalScript.extract` changes,
    // clear the parsed dialogue (now stale wrt the new text) and mirror the
    // change into the parent `sequences.script` so script view stays in sync.
    // Prompt-input-hash staleness handles the Image/Motion banners on its
    // own — `originalScript.extract` is part of the hashed scene context, so
    // the next `getFrameStalenessFn` call will report `'stale'` without us
    // touching the stored prompt hashes here.
    const oldExtract = context.frame.metadata?.originalScript.extract ?? '';
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

      // Bootstrap missing prompt-input hashes. Frames that were generated
      // before hash tracking landed have `imagePrompt` / `motionPrompt` set
      // but null hashes and no `frame_prompt_variants` rows — so the
      // `getLatestWithInputHash` fallback in `getFrameStalenessFn` can't
      // find a reference either, and staleness stays `'untracked'` forever.
      // Compute the hash from the PRE-edit scene and stamp it on the frame
      // now: the post-edit live hash will then differ → banner flips
      // `'stale'`. One-shot per frame; subsequent edits hit the normal hash
      // chain.
      let preEditSequenceForSplice: Awaited<
        ReturnType<typeof context.scopedDb.sequences.getById>
      > | null = null;
      if (context.frame.metadata) {
        if (context.frame.imagePrompt && !context.frame.visualPromptInputHash) {
          try {
            preEditSequenceForSplice ??=
              await context.scopedDb.sequences.getById(sequenceId);
            if (preEditSequenceForSplice) {
              const ctx = await loadNarrowFramePromptContext({
                scopedDb: context.scopedDb,
                sequence: {
                  id: preEditSequenceForSplice.id,
                  styleId: preEditSequenceForSplice.styleId,
                  aspectRatio: preEditSequenceForSplice.aspectRatio,
                  analysisModel: preEditSequenceForSplice.analysisModel,
                },
                scene: context.frame.metadata,
              });
              updateData.visualPromptInputHash =
                await computeVisualPromptInputHash(ctx);
            }
          } catch (err) {
            logger.warn(
              `Could not bootstrap visual hash for frame ${frameId}; staleness will remain untracked for this prompt`,
              { err }
            );
          }
        }
        if (
          context.frame.motionPrompt &&
          !context.frame.motionPromptInputHash
        ) {
          try {
            preEditSequenceForSplice ??=
              await context.scopedDb.sequences.getById(sequenceId);
            if (preEditSequenceForSplice) {
              const ctx = await loadNarrowFramePromptContext({
                scopedDb: context.scopedDb,
                sequence: {
                  id: preEditSequenceForSplice.id,
                  styleId: preEditSequenceForSplice.styleId,
                  aspectRatio: preEditSequenceForSplice.aspectRatio,
                  analysisModel: preEditSequenceForSplice.analysisModel,
                },
                scene: context.frame.metadata,
                startingFrameImageUrl: context.frame.thumbnailUrl,
              });
              updateData.motionPromptInputHash =
                await computeMotionPromptInputHash(ctx);
            }
          } catch (err) {
            logger.warn(
              `Could not bootstrap motion hash for frame ${frameId}; staleness will remain untracked for this prompt`,
              { err }
            );
          }
        }
      }

      // Splice the new extract into the parent script. The naive
      // `script.replace(oldExtract, …)` would corrupt the wrong scene
      // whenever an extract appears more than once (recurring slug lines,
      // "CUT TO BLACK.", duplicated cues). Instead, walk every frame in
      // orderIndex order and locate each one's extract sequentially in
      // `seq.script`; the target frame's match is the one we splice.
      // Best-effort: if the walk falls out of sync (e.g. the parent was
      // edited separately), leave the parent untouched — the frame still
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
          await context.scopedDb.frames.listBySequence(sequenceId);
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
          if (sibling.id === frameId) {
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
            `Parent script walk could not locate frame ${frameId} for sequence ${sequenceId}; skipping parent script sync`
          );
        }
      }
    }

    // When a user edits a prompt, auto-link any element/cast/location tags
    // they mentioned by additively merging them into frame.metadata.continuity
    // so the next generation pulls those references in (#683). Skip when the
    // prompt value hasn't actually changed, so plain saves stay a single
    // UPDATE with no extra reads.
    const imagePromptChanged =
      updateData.imagePrompt !== undefined &&
      updateData.imagePrompt !== context.frame.imagePrompt;
    const motionPromptChanged =
      updateData.motionPrompt !== undefined &&
      updateData.motionPrompt !== context.frame.motionPrompt;
    const frameMetadata = context.frame.metadata;
    if (
      (imagePromptChanged || motionPromptChanged) &&
      frameMetadata?.continuity
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
        existing: frameMetadata.continuity,
        promptText,
      });

      if (rescan.changed) {
        updateData.metadata = {
          ...frameMetadata,
          continuity: rescan.continuity,
        };
      }
    }

    return context.scopedDb.frames.update(frameId, updateData);
  });

export const deleteFrameFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameIdInputSchema))
  .handler(async ({ data, context }) => {
    await context.scopedDb.frames.delete(data.frameId);
    return { success: true, sequenceId: data.sequenceId };
  });

export const deleteFramesBySequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    await context.scopedDb.frames.deleteBySequence(context.sequence.id);
    return { success: true };
  });

export const reorderFramesFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        frameOrders: z
          .array(z.object({ id: ulidSchema, orderIndex: z.number().int() }))
          .min(1),
      })
    )
  )
  .handler(async ({ data, context }) => {
    const frameOrders = data.frameOrders.map((f) => ({
      id: f.id,
      order_index: f.orderIndex,
    }));
    await context.scopedDb.frames.reorder(data.sequenceId, frameOrders);
    return { success: true };
  });

/**
 * Returns staleness state for a frame's artifacts. Covers the rendered
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
export const getFrameStalenessFn = createServerFn({ method: 'GET' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameIdInputSchema))
  .handler(async ({ context }) => {
    const { frame, sequence, scopedDb } = context;

    let thumbnail: 'stale' | 'fresh' | 'untracked' = 'untracked';
    // Effective prompt: same fallback chain as `buildRegenerateFrameSnapshot`
    // and `generateFrameImageFn`. `frame.imagePrompt` alone misses
    // AI-generated frames (where `imagePrompt` stays null) and frames whose
    // visual prompt was regenerated (which only updates metadata). See #713.
    const effectivePrompt =
      frame.imagePrompt || frame.metadata?.prompts?.visual?.fullPrompt;
    if (effectivePrompt) {
      // Distinguish "stored hash absent" from "stored hash matches". A null
      // stored hash means the image predates hash tracking (or was generated
      // by a pre-fix `generateFrameImageFn` that didn't pass a sceneSnapshot)
      // — we genuinely have no opinion, so 'untracked' rather than lying with
      // 'fresh'. Once the user regenerates the image once under the new code
      // path, this column populates and the live-vs-stored comparison takes
      // over.
      if (frame.thumbnailInputHash === null) {
        thumbnail = 'untracked';
      } else {
        try {
          const [characters, locations, elements] = await Promise.all([
            scopedDb.characters.listWithSheets(sequence.id),
            scopedDb.sequenceLocations.listWithReferences(sequence.id),
            scopedDb.sequenceElements.list(sequence.id),
          ]);

          const snapshot = await buildRegenerateFrameSnapshot({
            frame,
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
            snapshot.snapshotInputHash !== frame.thumbnailInputHash
              ? 'stale'
              : 'fresh';
        } catch (error) {
          // Mirror the visual/motion branches: a thumbnail-hash failure (e.g.
          // transient D1 read, malformed element/location row) must not throw
          // out of the whole handler — that would null the entire staleness
          // result and silently suppress the visual/motion banners too. Stay
          // 'untracked' (fail-open as 'fresh' would lie about freshness).
          logger.warn(
            `thumbnail staleness uncomputable for frame ${frame.id}:`,
            {
              err: error,
            }
          );
        }
      }
    }

    let visualPrompt: 'stale' | 'fresh' | 'untracked' = 'untracked';
    let motionPrompt: 'stale' | 'fresh' | 'untracked' = 'untracked';

    // Reference hash resolution: prefer the cached column on `frames`, but
    // fall back to the most recent variant with a non-null `inputHash` for
    // frames whose cached column was nulled by a pre-fix user-edit. Without
    // the fallback, those frames are stuck at `'untracked'` permanently.
    if (frame.metadata) {
      let referenceHash = frame.visualPromptInputHash;
      if (!referenceHash) {
        const fallback =
          await scopedDb.framePromptVariants.getLatestWithInputHash(
            frame.id,
            'visual'
          );
        referenceHash = fallback?.inputHash ?? null;
      }
      if (referenceHash) {
        try {
          const latest = await scopedDb.framePromptVariants.getLatest(
            frame.id,
            'visual'
          );
          const ctx = await loadNarrowFramePromptContext({
            scopedDb,
            sequence,
            scene: frame.metadata,
            analysisModelOverride: latest?.analysisModel ?? null,
          });
          const liveHash = await computeVisualPromptInputHash(ctx);
          visualPrompt = liveHash !== referenceHash ? 'stale' : 'fresh';
        } catch (error) {
          // Context unavailable (e.g., style deleted mid-flight). Stay
          // 'untracked' — fail-open as 'fresh' would silently lie to the user.
          logger.warn(`visual staleness uncomputable for frame ${frame.id}:`, {
            err: error,
          });
        }
      }
    }

    if (frame.metadata) {
      let referenceHash = frame.motionPromptInputHash;
      if (!referenceHash) {
        const fallback =
          await scopedDb.framePromptVariants.getLatestWithInputHash(
            frame.id,
            'motion'
          );
        referenceHash = fallback?.inputHash ?? null;
      }
      if (referenceHash) {
        try {
          const latest = await scopedDb.framePromptVariants.getLatest(
            frame.id,
            'motion'
          );
          const ctx = await loadNarrowFramePromptContext({
            scopedDb,
            sequence,
            scene: frame.metadata,
            analysisModelOverride: latest?.analysisModel ?? null,
            startingFrameImageUrl: frame.thumbnailUrl,
          });
          const liveHash = await computeMotionPromptInputHash(ctx);
          motionPrompt = liveHash !== referenceHash ? 'stale' : 'fresh';
        } catch (error) {
          logger.warn(`motion staleness uncomputable for frame ${frame.id}:`, {
            err: error,
          });
        }
      }
    }

    return { thumbnail, visualPrompt, motionPrompt };
  });

/**
 * Get a signed download URL for a frame's video.
 * Uses Content-Disposition: attachment to force browser download.
 */
export const getFrameDownloadUrlFn = createServerFn({ method: 'GET' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameIdInputSchema))
  .handler(async ({ context }) => {
    const { frame } = context;

    if (!frame.videoPath) {
      throw new Error('Frame does not have a video');
    }

    const filename =
      frame.videoPath.split('/').pop() || `scene-${frame.id}_openstory.mp4`;

    const downloadUrl = await getVideoDownloadUrl(
      frame.videoPath,
      filename,
      3600
    );

    return { downloadUrl, filename };
  });
