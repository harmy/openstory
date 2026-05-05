/**
 * Scoped Frame Variants Sub-module
 * CRUD operations for per-model generation outputs on frames.
 */

import type { Database } from '@/lib/db/client';
import type {
  Frame,
  FrameVariant,
  NewFrame,
  NewFrameVariant,
} from '@/lib/db/schema';
import { frameVariants, frames } from '@/lib/db/schema';
import type { VariantType } from '@/lib/db/schema/frame-variants';
import { and, eq, sql } from 'drizzle-orm';

export function createFrameVariantsMethods(db: Database) {
  return {
    getByFrameAndModel: async (
      frameId: string,
      variantType: VariantType,
      model: string
    ): Promise<FrameVariant | null> => {
      // Scoped to the primary row (divergedAt IS NULL). Without this filter the
      // partial-index split lets divergent alternates share the (frame, type,
      // model) triple, so a bare select would non-deterministically return
      // either the primary or one of the alternates.
      const result = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.frameId, frameId),
            eq(frameVariants.variantType, variantType),
            eq(frameVariants.model, model),
            sql`${frameVariants.divergedAt} IS NULL`
          )
        );
      return result[0] ?? null;
    },

    listByFrame: async (
      frameId: string,
      variantType?: VariantType
    ): Promise<FrameVariant[]> => {
      const conditions = [eq(frameVariants.frameId, frameId)];
      if (variantType) {
        conditions.push(eq(frameVariants.variantType, variantType));
      }
      return db
        .select()
        .from(frameVariants)
        .where(and(...conditions));
    },

    listBySequence: async (
      sequenceId: string,
      variantType: VariantType
    ): Promise<FrameVariant[]> => {
      return db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.sequenceId, sequenceId),
            eq(frameVariants.variantType, variantType)
          )
        );
    },

    listModelsForSequence: async (
      sequenceId: string,
      variantType: VariantType
    ): Promise<string[]> => {
      const result = await db
        .selectDistinct({ model: frameVariants.model })
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.sequenceId, sequenceId),
            eq(frameVariants.variantType, variantType)
          )
        );
      return result.map((r) => r.model);
    },

    upsert: async (data: NewFrameVariant): Promise<FrameVariant> => {
      const [variant] = await db
        .insert(frameVariants)
        .values(data)
        .onConflictDoUpdate({
          target: [
            frameVariants.frameId,
            frameVariants.variantType,
            frameVariants.model,
          ],
          // Targets the primary partial unique index; divergent alternates
          // (divergedAt IS NOT NULL) sit in a separate index and are never
          // touched by upsert.
          targetWhere: sql`${frameVariants.divergedAt} IS NULL`,
          set: {
            url: sql.raw(`excluded."url"`),
            storagePath: sql.raw(`excluded."storage_path"`),
            previewUrl: sql.raw(`excluded."preview_url"`),
            status: sql.raw(`excluded."status"`),
            workflowRunId: sql.raw(`excluded."workflow_run_id"`),
            generatedAt: sql.raw(`excluded."generated_at"`),
            error: sql.raw(`excluded."error"`),
            promptHash: sql.raw(`excluded."prompt_hash"`),
            durationMs: sql.raw(`excluded."duration_ms"`),
            updatedAt: new Date(),
          },
        })
        .returning();
      return variant;
    },

    update: async (
      variantId: string,
      data: Partial<NewFrameVariant>
    ): Promise<FrameVariant> => {
      const result = await db
        .update(frameVariants)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(frameVariants.id, variantId))
        .returning();
      const variant = result.at(0);
      if (!variant) {
        throw new Error(`FrameVariant ${variantId} not found`);
      }
      return variant;
    },

    updateByFrameAndModel: async (
      frameId: string,
      variantType: VariantType,
      model: string,
      data: Partial<NewFrameVariant>
    ): Promise<FrameVariant | null> => {
      // Scoped to the primary row (divergedAt IS NULL) so divergent alternates
      // sharing the same (frame, type, model) triple are never overwritten.
      const result = await db
        .update(frameVariants)
        .set({ ...data, updatedAt: new Date() })
        .where(
          and(
            eq(frameVariants.frameId, frameId),
            eq(frameVariants.variantType, variantType),
            eq(frameVariants.model, model),
            sql`${frameVariants.divergedAt} IS NULL`
          )
        )
        .returning();
      return result.at(0) ?? null;
    },

    /**
     * Insert a divergent alternate row. Idempotent on (frame, type, model,
     * inputHash) within the divergent partial unique index so QStash retries
     * of the same reconcile step don't collide on a row already inserted on a
     * previous attempt. Returns the existing row on retry so callers can
     * reference its id (e.g. when re-emitting the realtime `stale:detected`
     * event after a step retry).
     *
     * Pre-checks existence rather than `onConflictDoNothing` because drizzle's
     * SQLite `onConflictDoNothing` does not emit the partial-index `WHERE`
     * predicate after the target column list — without it SQLite cannot match
     * the divergent partial unique index, and the conflict raises instead of
     * being absorbed.
     */
    insertDivergent: async (
      data: NewFrameVariant & { inputHash: string; divergedAt: Date }
    ): Promise<FrameVariant> => {
      const existing = await db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.frameId, data.frameId),
            eq(frameVariants.variantType, data.variantType),
            eq(frameVariants.model, data.model),
            eq(frameVariants.inputHash, data.inputHash),
            sql`${frameVariants.divergedAt} IS NOT NULL`
          )
        );
      if (existing.length > 0) {
        return existing[0];
      }
      const [variant] = await db.insert(frameVariants).values(data).returning();
      return variant;
    },

    isStale: async (
      variantId: string,
      currentHash: string
    ): Promise<boolean> => {
      const result = await db
        .select({ hash: frameVariants.inputHash })
        .from(frameVariants)
        .where(eq(frameVariants.id, variantId));
      if (result.length === 0) {
        throw new Error(`FrameVariant ${variantId} not found`);
      }
      const stored = result[0].hash;
      if (stored === null) return false;
      return currentHash !== stored;
    },

    /**
     * List divergent alternates for a frame (or all frames in a sequence) that
     * have not been discarded. Ordered oldest-first by divergedAt so the UI
     * surfaces the longest-pending alternate consistently.
     */
    listDivergentByFrame: async (
      frameId: string,
      variantType?: VariantType
    ): Promise<FrameVariant[]> => {
      const conditions = [
        eq(frameVariants.frameId, frameId),
        sql`${frameVariants.divergedAt} IS NOT NULL`,
        sql`${frameVariants.discardedAt} IS NULL`,
      ];
      if (variantType) {
        conditions.push(eq(frameVariants.variantType, variantType));
      }
      return db
        .select()
        .from(frameVariants)
        .where(and(...conditions))
        .orderBy(frameVariants.divergedAt);
    },

    listDivergentBySequence: async (
      sequenceId: string
    ): Promise<FrameVariant[]> => {
      return db
        .select()
        .from(frameVariants)
        .where(
          and(
            eq(frameVariants.sequenceId, sequenceId),
            sql`${frameVariants.divergedAt} IS NOT NULL`,
            sql`${frameVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(frameVariants.divergedAt);
    },

    /**
     * Mark a divergent alternate as discarded. Idempotent; returns the
     * timestamp set so the caller can stash it for an Undo action.
     */
    discard: async (variantId: string): Promise<Date> => {
      const discardedAt = new Date();
      const result = await db
        .update(frameVariants)
        .set({ discardedAt, updatedAt: discardedAt })
        .where(eq(frameVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`FrameVariant ${variantId} not found`);
      }
      return discardedAt;
    },

    /**
     * Atomically replace the live primary on `frames` with the variant's
     * fields and soft-delete the variant. Both writes run in a single
     * `db.batch()` (one libSQL transaction) so partial failure isn't
     * possible at the SQL layer.
     *
     * Pre-checks existence so a missing frame or variant fails fast with a
     * specific error before the batch runs. Without the pre-check, a
     * zero-row UPDATE silently succeeds inside the batch, forcing ambiguous
     * post-batch reasoning about which side was missing.
     */
    promoteAtomically: async (
      frameId: string,
      frameUpdate: Partial<NewFrame>,
      variantId: string
    ): Promise<{ frame: Frame; discardedAt: Date }> => {
      const [existingFrame] = await db
        .select({ id: frames.id })
        .from(frames)
        .where(eq(frames.id, frameId));
      if (!existingFrame) {
        throw new Error(`Frame ${frameId} not found`);
      }
      const [existingVariant] = await db
        .select({ id: frameVariants.id })
        .from(frameVariants)
        .where(eq(frameVariants.id, variantId));
      if (!existingVariant) {
        throw new Error(`FrameVariant ${variantId} not found`);
      }

      const now = new Date();
      const updateFrame = db
        .update(frames)
        .set({ ...frameUpdate, updatedAt: now })
        .where(eq(frames.id, frameId))
        .returning();
      const discardVariant = db
        .update(frameVariants)
        .set({ discardedAt: now, updatedAt: now })
        .where(eq(frameVariants.id, variantId))
        .returning();
      const [frameRows, variantRows] = await db.batch([
        updateFrame,
        discardVariant,
      ]);
      // Existence was checked above. A zero-row result on either side means
      // the row was deleted between the pre-check and the batch — surface
      // it so the caller sees the inconsistency rather than silently
      // discarding a nonexistent variant or "promoting" with no live frame.
      if (frameRows.length === 0) {
        throw new Error(`Frame ${frameId} disappeared during promote`);
      }
      if (variantRows.length === 0) {
        throw new Error(`FrameVariant ${variantId} disappeared during promote`);
      }
      return { frame: frameRows[0], discardedAt: now };
    },

    /**
     * Undo a previous discard by clearing discardedAt. Used by the sonner
     * toast Undo action.
     */
    undiscard: async (variantId: string): Promise<void> => {
      const result = await db
        .update(frameVariants)
        .set({ discardedAt: null, updatedAt: new Date() })
        .where(eq(frameVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`FrameVariant ${variantId} not found`);
      }
    },

    /**
     * Look up a divergent variant by id. Used by the promote/discard server
     * functions to confirm the row exists and is still divergent before
     * acting.
     */
    getById: async (variantId: string): Promise<FrameVariant | null> => {
      const result = await db
        .select()
        .from(frameVariants)
        .where(eq(frameVariants.id, variantId));
      return result[0] ?? null;
    },

    deleteByFrame: async (frameId: string): Promise<number> => {
      const result = await db
        .delete(frameVariants)
        .where(eq(frameVariants.frameId, frameId));
      return result.rowsAffected;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(frameVariants)
        .where(eq(frameVariants.sequenceId, sequenceId));
      return result.rowsAffected;
    },
  };
}
