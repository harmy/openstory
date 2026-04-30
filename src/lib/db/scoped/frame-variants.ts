/**
 * Scoped Frame Variants Sub-module
 * CRUD operations for per-model generation outputs on frames.
 */

import type { Database } from '@/lib/db/client';
import type { FrameVariant, NewFrameVariant } from '@/lib/db/schema';
import { frameVariants } from '@/lib/db/schema';
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
     * previous attempt. Returns null when the row already exists (caller has
     * no use for the row beyond knowing the insert succeeded once).
     *
     * Pre-checks existence rather than `onConflictDoNothing` because drizzle's
     * SQLite `onConflictDoNothing` does not emit the partial-index `WHERE`
     * predicate after the target column list — without it SQLite cannot match
     * the divergent partial unique index, and the conflict raises instead of
     * being absorbed.
     */
    insertDivergent: async (
      data: NewFrameVariant & { inputHash: string; divergedAt: Date }
    ): Promise<FrameVariant | null> => {
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
        return null;
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
