/**
 * Scoped Frame Variants Sub-module (flat, append-only image versions).
 *
 * Each row is ONE image generation — a *version*. A "variant" is the emergent
 * group of rows sharing `(frameId, kind, model, sourceVariantId)`; its
 * "versions" are those rows ordered by time (ULID). Re-rolls **accumulate** —
 * append never overwrites, so a video render manifest can reference a version
 * id as a stable snapshot.
 *
 * **Selection is a pointer, not a per-row flag.** The frame's current image is
 * whichever version `frames.selectedImageVersionId` points at; revert /
 * switch-model is a {@link select} repoint. `discardedAt` soft-hides a version
 * (undoable); there is no `divergedAt` (retired in the redesign).
 *
 * Every mutation commits its state change (the frame mirror for {@link select},
 * the `discardedAt` write for discard / undiscard) and its `sequence_events`
 * row in the SAME `db.batch()` (see {@link buildEventInsert}), so the change and
 * its activity entry are atomic.
 *
 * See docs/architecture/scene-shot-frame-redesign.md.
 */

import type { Database } from '@/lib/db/client';
import { frameVariants, frames } from '@/lib/db/schema';
import type { FrameVariant, NewFrameVariant } from '@/lib/db/schema';
import type { FrameVariantKind } from '@/lib/db/schema/frame-variants';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { buildFrameImageMirror } from './frames';
import { buildEventInsert } from './sequence-events';

/** The grouping key that makes a flat row set read as a "variant". */
type VariantGroup = {
  frameId: string;
  kind: FrameVariantKind;
  model: string;
  /** Only for `kind: 'framing'` rows — the model image the 3×3 came from. */
  sourceVariantId?: string | null;
};

export function createFrameVariantsMethods(db: Database) {
  return {
    getById: async (versionId: string): Promise<FrameVariant | null> => {
      const result = await db
        .select()
        .from(frameVariants)
        .where(eq(frameVariants.id, versionId));
      return result[0] ?? null;
    },

    /**
     * Append a new version row. Pure append — even when the inputs match an
     * existing version (a deliberate re-roll), a fresh row is created so the
     * history accumulates. Idempotency for workflow retries is the caller's
     * concern (Phase 2), not enforced here.
     */
    appendVersion: async (data: NewFrameVariant): Promise<FrameVariant> => {
      const [version] = await db.insert(frameVariants).values(data).returning();
      if (!version) {
        throw new Error(
          `Failed to append frame variant for frame ${data.frameId}`
        );
      }
      return version;
    },

    /** Update generation tracking on an in-flight version (status/url/error/…). */
    update: async (
      versionId: string,
      data: Partial<NewFrameVariant>
    ): Promise<FrameVariant> => {
      const [version] = await db
        .update(frameVariants)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(frameVariants.id, versionId))
        .returning();
      if (!version) {
        throw new Error(`FrameVariant ${versionId} not found`);
      }
      return version;
    },

    /**
     * The versions of one variant group, oldest-first so a per-model ordinal
     * label ("v1, v2, …") derives from position. Discarded rows are excluded
     * unless `includeDiscarded`.
     */
    listByGroup: async (
      group: VariantGroup,
      options?: { includeDiscarded?: boolean }
    ): Promise<FrameVariant[]> => {
      const conditions = [
        eq(frameVariants.frameId, group.frameId),
        eq(frameVariants.kind, group.kind),
        eq(frameVariants.model, group.model),
      ];
      // sourceVariantId distinguishes framing groups; match null explicitly so
      // model groups (null source) don't collide with framing picks.
      conditions.push(
        group.sourceVariantId == null
          ? isNull(frameVariants.sourceVariantId)
          : eq(frameVariants.sourceVariantId, group.sourceVariantId)
      );
      if (!options?.includeDiscarded) {
        conditions.push(isNull(frameVariants.discardedAt));
      }
      return await db
        .select()
        .from(frameVariants)
        .where(and(...conditions))
        .orderBy(asc(frameVariants.id));
    },

    /** All versions for a frame, oldest-first. Excludes discarded by default. */
    listByFrame: async (
      frameId: string,
      options?: { includeDiscarded?: boolean }
    ): Promise<FrameVariant[]> => {
      const conditions = [eq(frameVariants.frameId, frameId)];
      if (!options?.includeDiscarded) {
        conditions.push(isNull(frameVariants.discardedAt));
      }
      return await db
        .select()
        .from(frameVariants)
        .where(and(...conditions))
        .orderBy(asc(frameVariants.id));
    },

    /** The version the frame currently points at, or null if unset/dangling. */
    getSelected: async (frameId: string): Promise<FrameVariant | null> => {
      const [frame] = await db
        .select({ selected: frames.selectedImageVersionId })
        .from(frames)
        .where(eq(frames.id, frameId));
      if (!frame?.selected) return null;
      const [version] = await db
        .select()
        .from(frameVariants)
        .where(eq(frameVariants.id, frame.selected));
      return version ?? null;
    },

    /**
     * Repoint the frame's selection at `versionId`: set
     * `frames.selectedImageVersionId`, mirror the version's image fields onto
     * the frame, and append an `image.selected` activity event — all in one
     * `db.batch()` so the pointer move and its event are atomic. The event's
     * `data` carries the previous pointer so the change is undoable. Returns
     * the selected version.
     */
    select: async (
      frameId: string,
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<FrameVariant> => {
      const [version] = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.id, versionId),
            eq(frameVariants.frameId, frameId)
          )
        );
      if (!version) {
        throw new Error(
          `FrameVariant ${versionId} not found for frame ${frameId}`
        );
      }
      // Only a finished image may become the frame's primary still. Selecting a
      // pending/failed version would mirror its null url + failed status onto
      // the frame, silently blanking a good image.
      if (version.status !== 'completed') {
        throw new Error(
          `FrameVariant ${versionId} is '${version.status}', not 'completed' — cannot select an unfinished image`
        );
      }
      const [frame] = await db
        .select({
          sequenceId: frames.sequenceId,
          prev: frames.selectedImageVersionId,
        })
        .from(frames)
        .where(eq(frames.id, frameId));
      if (!frame) {
        throw new Error(`Frame ${frameId} not found`);
      }

      await db.batch([
        buildFrameImageMirror(db, frameId, version),
        buildEventInsert(db, {
          sequenceId: frame.sequenceId,
          actorId: opts.actorId,
          kind: 'image.selected',
          targetType: 'frame',
          targetId: frameId,
          summary: `Selected ${version.model} image`,
          data: {
            versionId,
            model: version.model,
            prevVersionId: frame.prev ?? null,
          },
        }),
      ]);
      return version;
    },

    /**
     * Soft-hide a version (undoable). Commits the `discardedAt` write and an
     * `image.discarded` event in one batch. Returns the timestamp for an Undo.
     */
    discard: async (
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<Date> => {
      const [version] = await db
        .select({ sequenceId: frameVariants.sequenceId })
        .from(frameVariants)
        .where(eq(frameVariants.id, versionId));
      if (!version) {
        throw new Error(`FrameVariant ${versionId} not found`);
      }
      const discardedAt = new Date();
      await db.batch([
        db
          .update(frameVariants)
          .set({ discardedAt, updatedAt: discardedAt })
          .where(eq(frameVariants.id, versionId)),
        buildEventInsert(db, {
          sequenceId: version.sequenceId,
          actorId: opts.actorId,
          kind: 'image.discarded',
          targetType: 'variant',
          targetId: versionId,
          data: { versionId },
        }),
      ]);
      return discardedAt;
    },

    /** Undo a discard (clears `discardedAt`), with a matching event. */
    undiscard: async (
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<void> => {
      const [version] = await db
        .select({ sequenceId: frameVariants.sequenceId })
        .from(frameVariants)
        .where(eq(frameVariants.id, versionId));
      if (!version) {
        throw new Error(`FrameVariant ${versionId} not found`);
      }
      const now = new Date();
      await db.batch([
        db
          .update(frameVariants)
          .set({ discardedAt: null, updatedAt: now })
          .where(eq(frameVariants.id, versionId)),
        buildEventInsert(db, {
          sequenceId: version.sequenceId,
          actorId: opts.actorId,
          kind: 'image.undiscarded',
          targetType: 'variant',
          targetId: versionId,
          data: { versionId },
        }),
      ]);
    },

    /**
     * Staleness of a single version: stored `inputHash` vs a fresh hash. Null
     * stored hash (legacy / in-flight) is "unknown, not stale". Throws when the
     * version is missing. Mirrors `shotVariants.isStale`.
     */
    isStale: async (
      versionId: string,
      currentHash: string
    ): Promise<boolean> => {
      const result = await db
        .select({ hash: frameVariants.inputHash })
        .from(frameVariants)
        .where(eq(frameVariants.id, versionId));
      const row = result[0];
      if (!row) {
        throw new Error(`FrameVariant ${versionId} not found`);
      }
      const stored = row.hash;
      if (stored === null) return false;
      return currentHash !== stored;
    },

    deleteByFrame: async (frameId: string): Promise<number> => {
      const result = await db
        .delete(frameVariants)
        .where(eq(frameVariants.frameId, frameId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(frameVariants)
        .where(eq(frameVariants.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },
  };
}
