/**
 * Scoped Frames Sub-module
 *
 * A frame is the IMAGE unit — one still keyframe within a shot (1 frame = 1
 * image). A shot owns 1..N frames (role first|last|key). The frame's primary
 * still is a cached MIRROR of whichever `frame_variants` version
 * `frames.selectedImageVersionId` points at; the model alternates live in
 * `frame_variants` and the visual-prompt history in `frame_prompt_versions`.
 *
 * The mirror columns (`imageUrl`, `imagePath`, …) are written here via
 * {@link buildFrameImageMirror} so the "which columns mirror a selected
 * version" knowledge lives with the frame; `frame_variants.select` composes
 * that statement into its repoint batch.
 *
 * See docs/architecture/scene-shot-frame-redesign.md.
 */

import type { Database } from '@/lib/db/client';
import { frameVariants, frames } from '@/lib/db/schema';
import type { Frame, FrameVariant, NewFrame } from '@/lib/db/schema';
import { asc, desc, eq, inArray } from 'drizzle-orm';

/** A frame plus the `frame_variants` version it currently points at (if any). */
export type ResolvedFrame = {
  frame: Frame;
  selectedVersion: FrameVariant | null;
};

/**
 * Build (without executing) the UPDATE that mirrors a selected version's image
 * fields onto its frame, so a caller can compose it into the same `db.batch()`
 * as the selection-pointer write and the activity event. Returns the drizzle
 * statement; the caller owns execution.
 *
 * Mirrors the output fields only — `role` / `source` / `orderIndex` are frame
 * identity and never change on a selection repoint.
 */
export function buildFrameImageMirror(
  db: Database,
  frameId: string,
  version: FrameVariant
) {
  return db
    .update(frames)
    .set({
      selectedImageVersionId: version.id,
      imageUrl: version.url,
      imagePath: version.storagePath,
      previewImageUrl: version.previewUrl,
      imageStatus: version.status,
      imageGeneratedAt: version.generatedAt,
      imageError: version.error,
      imageModel: version.model,
      imageInputHash: version.inputHash,
      updatedAt: new Date(),
    })
    .where(eq(frames.id, frameId));
}

type FrameOrderBy = 'orderIndex' | 'createdAt' | 'updatedAt';

/**
 * Columns owned by the selection / mirror paths ({@link buildFrameImageMirror}
 * via `frameVariants.select`, and `framePromptVersions.write`/`select`). They
 * are excluded from the generic `update` input so a partial write can never
 * leave the selection pointer and its mirrored columns diverged — the only way
 * to move a selection is through those methods, which repoint + mirror (and log
 * the event) atomically.
 */
type FrameMirrorColumn =
  | 'selectedImageVersionId'
  | 'imageUrl'
  | 'imagePath'
  | 'previewImageUrl'
  | 'imageStatus'
  | 'imageGeneratedAt'
  | 'imageError'
  | 'imageModel'
  | 'imageInputHash'
  | 'selectedImagePromptVersionId'
  | 'imagePrompt'
  | 'visualPromptInputHash';

/** Fields `update` accepts — everything on a frame except the mirror columns. */
export type FrameUpdateInput = Omit<Partial<NewFrame>, FrameMirrorColumn>;

export function createFramesMethods(db: Database) {
  return {
    getById: async (frameId: string): Promise<Frame | null> => {
      const result = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frameId));
      return result[0] ?? null;
    },

    getByIds: async (frameIds: string[]): Promise<Frame[]> => {
      if (frameIds.length === 0) return [];
      return await db.select().from(frames).where(inArray(frames.id, frameIds));
    },

    /** Frames of a shot, ordered (0 = first/anchor by default). */
    listByShot: async (shotId: string): Promise<Frame[]> => {
      return await db
        .select()
        .from(frames)
        .where(eq(frames.shotId, shotId))
        .orderBy(asc(frames.orderIndex));
    },

    listBySequence: async (
      sequenceId: string,
      options?: { orderBy?: FrameOrderBy; ascending?: boolean }
    ): Promise<Frame[]> => {
      const { orderBy = 'createdAt', ascending = true } = options ?? {};
      const orderColumn =
        orderBy === 'orderIndex'
          ? frames.orderIndex
          : orderBy === 'updatedAt'
            ? frames.updatedAt
            : frames.createdAt;
      const orderFn = ascending ? asc : desc;
      return await db
        .select()
        .from(frames)
        .where(eq(frames.sequenceId, sequenceId))
        .orderBy(orderFn(orderColumn));
    },

    create: async (data: NewFrame): Promise<Frame> => {
      const [frame] = await db.insert(frames).values(data).returning();
      if (!frame) {
        throw new Error(`Failed to create frame for shot ${data.shotId}`);
      }
      return frame;
    },

    /**
     * Idempotent insert keyed on the `(shot_id, order_index)` unique index —
     * a replay re-deriving the same frame slot updates in place rather than
     * colliding. Identity columns (role/source) and the image mirror are left
     * to dedicated paths.
     */
    upsert: async (data: NewFrame): Promise<Frame> => {
      const [frame] = await db
        .insert(frames)
        .values(data)
        .onConflictDoUpdate({
          target: [frames.shotId, frames.orderIndex],
          set: { role: data.role, updatedAt: new Date() },
        })
        .returning();
      if (!frame) {
        throw new Error(
          `Failed to upsert frame for shot ${data.shotId} at orderIndex ${data.orderIndex}`
        );
      }
      return frame;
    },

    /**
     * Update non-mirror frame fields. Selection pointers and their mirrored
     * image / prompt columns are intentionally excluded (see
     * {@link FrameUpdateInput}); move a selection via `frameVariants.select` or
     * `framePromptVersions.write`/`select` instead.
     */
    update: async (
      frameId: string,
      data: FrameUpdateInput,
      options?: { throwOnMissing?: boolean }
    ): Promise<Frame | undefined> => {
      const [frame] = await db
        .update(frames)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(frames.id, frameId))
        .returning();
      if (!frame && options?.throwOnMissing !== false) {
        throw new Error(`Frame ${frameId} not found`);
      }
      return frame;
    },

    delete: async (frameId: string): Promise<boolean> => {
      const result = await db.delete(frames).where(eq(frames.id, frameId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteByShot: async (shotId: string): Promise<number> => {
      const result = await db.delete(frames).where(eq(frames.shotId, shotId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(frames)
        .where(eq(frames.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    /**
     * The frame plus its currently-selected image version. After a select the
     * frame's mirror columns already equal the version's, so reads can use
     * either; this exposes the underlying version row for callers that need
     * its provenance (model, hashes). Returns null if the frame is missing.
     */
    resolveCurrent: async (frameId: string): Promise<ResolvedFrame | null> => {
      const [frame] = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frameId));
      if (!frame) return null;
      if (!frame.selectedImageVersionId) {
        return { frame, selectedVersion: null };
      }
      const [version] = await db
        .select()
        .from(frameVariants)
        .where(eq(frameVariants.id, frame.selectedImageVersionId));
      return { frame, selectedVersion: version ?? null };
    },

    /**
     * Compare the stored `imageInputHash` against a fresh hash. A null stored
     * hash (legacy / never generated) is treated as "unknown, not stale"
     * rather than forcing regeneration. Throws when the frame is missing.
     * Mirrors `shots.isStale`.
     */
    isStale: async (frameId: string, currentHash: string): Promise<boolean> => {
      const result = await db
        .select({ hash: frames.imageInputHash })
        .from(frames)
        .where(eq(frames.id, frameId));
      const row = result[0];
      if (!row) {
        throw new Error(`Frame ${frameId} not found`);
      }
      const stored = row.hash;
      if (stored === null) return false;
      return currentHash !== stored;
    },
  };
}
