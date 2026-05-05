/**
 * Scoped Sequence Variants Sub-module
 * CRUD for sequence-level merged-video and music variants. Promotion writes
 * back to the matching `sequences.*` columns so existing UI keeps reading
 * those.
 *
 * Divergence routing: `writeVideoVariant` / `writeMusicVariant` compare the
 * incoming `inputHash` against the existing primary (if any) and route to
 * `insertDivergent*` when the hashes differ. This preserves the previous
 * primary instead of silently replacing it.
 */

import type { Database } from '@/lib/db/client';
import {
  sequenceMusicVariants,
  sequenceVideoVariants,
  sequences,
} from '@/lib/db/schema';
import type {
  NewSequenceMusicVariant,
  NewSequenceVideoVariant,
  SequenceMusicVariant,
  SequenceVideoVariant,
} from '@/lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { insertDivergentRaceTolerant } from './divergent-insert';

export type WriteVariantResult<T> = { variant: T; divergent: boolean };

export function createSequenceVariantsMethods(db: Database) {
  const getVideoPrimary = async (
    sequenceId: string,
    workflow: string
  ): Promise<SequenceVideoVariant | null> => {
    const result = await db
      .select()
      .from(sequenceVideoVariants)
      .where(
        and(
          eq(sequenceVideoVariants.sequenceId, sequenceId),
          eq(sequenceVideoVariants.workflow, workflow),
          sql`${sequenceVideoVariants.divergedAt} IS NULL`
        )
      );
    if (result.length > 1) {
      throw new Error(
        `[sequenceVariants] Multiple primary video variants found for sequence ${sequenceId} workflow ${workflow} — partial unique index violated`
      );
    }
    return result.at(0) ?? null;
  };

  const upsertVideoPrimary = async (
    data: NewSequenceVideoVariant
  ): Promise<SequenceVideoVariant> => {
    const result = await db
      .insert(sequenceVideoVariants)
      .values(data)
      .onConflictDoUpdate({
        target: [
          sequenceVideoVariants.sequenceId,
          sequenceVideoVariants.workflow,
        ],
        targetWhere: sql`${sequenceVideoVariants.divergedAt} IS NULL`,
        set: {
          url: sql.raw(`excluded."url"`),
          storagePath: sql.raw(`excluded."storage_path"`),
          status: sql.raw(`excluded."status"`),
          workflowRunId: sql.raw(`excluded."workflow_run_id"`),
          generatedAt: sql.raw(`excluded."generated_at"`),
          error: sql.raw(`excluded."error"`),
          inputHash: sql.raw(`excluded."input_hash"`),
          updatedAt: new Date(),
        },
      })
      .returning();
    const variant = result.at(0);
    if (!variant) {
      throw new Error('upsertVideoPrimary returned no row');
    }
    return variant;
  };

  const insertDivergentVideo = async (
    data: NewSequenceVideoVariant & { inputHash: string; divergedAt: Date }
  ): Promise<SequenceVideoVariant> => {
    const findExisting = () =>
      db
        .select()
        .from(sequenceVideoVariants)
        .where(
          and(
            eq(sequenceVideoVariants.sequenceId, data.sequenceId),
            eq(sequenceVideoVariants.workflow, data.workflow),
            eq(sequenceVideoVariants.inputHash, data.inputHash),
            sql`${sequenceVideoVariants.divergedAt} IS NOT NULL`
          )
        );
    return insertDivergentRaceTolerant({
      findExisting,
      insert: () => db.insert(sequenceVideoVariants).values(data).returning(),
      errorMessage: 'insertDivergentVideo returned no row',
    });
  };

  const getMusicPrimary = async (
    sequenceId: string,
    model: string
  ): Promise<SequenceMusicVariant | null> => {
    const result = await db
      .select()
      .from(sequenceMusicVariants)
      .where(
        and(
          eq(sequenceMusicVariants.sequenceId, sequenceId),
          eq(sequenceMusicVariants.model, model),
          sql`${sequenceMusicVariants.divergedAt} IS NULL`
        )
      );
    if (result.length > 1) {
      throw new Error(
        `[sequenceVariants] Multiple primary music variants found for sequence ${sequenceId} model ${model} — partial unique index violated`
      );
    }
    return result.at(0) ?? null;
  };

  const upsertMusicPrimary = async (
    data: NewSequenceMusicVariant
  ): Promise<SequenceMusicVariant> => {
    const result = await db
      .insert(sequenceMusicVariants)
      .values(data)
      .onConflictDoUpdate({
        target: [sequenceMusicVariants.sequenceId, sequenceMusicVariants.model],
        targetWhere: sql`${sequenceMusicVariants.divergedAt} IS NULL`,
        set: {
          url: sql.raw(`excluded."url"`),
          storagePath: sql.raw(`excluded."storage_path"`),
          prompt: sql.raw(`excluded."prompt"`),
          tags: sql.raw(`excluded."tags"`),
          durationSeconds: sql.raw(`excluded."duration_seconds"`),
          status: sql.raw(`excluded."status"`),
          workflowRunId: sql.raw(`excluded."workflow_run_id"`),
          generatedAt: sql.raw(`excluded."generated_at"`),
          error: sql.raw(`excluded."error"`),
          inputHash: sql.raw(`excluded."input_hash"`),
          updatedAt: new Date(),
        },
      })
      .returning();
    const variant = result.at(0);
    if (!variant) {
      throw new Error('upsertMusicPrimary returned no row');
    }
    return variant;
  };

  const insertDivergentMusic = async (
    data: NewSequenceMusicVariant & { inputHash: string; divergedAt: Date }
  ): Promise<SequenceMusicVariant> => {
    const findExisting = () =>
      db
        .select()
        .from(sequenceMusicVariants)
        .where(
          and(
            eq(sequenceMusicVariants.sequenceId, data.sequenceId),
            eq(sequenceMusicVariants.model, data.model),
            eq(sequenceMusicVariants.inputHash, data.inputHash),
            sql`${sequenceMusicVariants.divergedAt} IS NOT NULL`
          )
        );
    return insertDivergentRaceTolerant({
      findExisting,
      insert: () => db.insert(sequenceMusicVariants).values(data).returning(),
      errorMessage: 'insertDivergentMusic returned no row',
    });
  };

  return {
    // ── Video variants ────────────────────────────────────────────────────
    listVideosBySequence: async (
      sequenceId: string
    ): Promise<SequenceVideoVariant[]> => {
      return db
        .select()
        .from(sequenceVideoVariants)
        .where(eq(sequenceVideoVariants.sequenceId, sequenceId));
    },

    getVideoPrimary,
    upsertVideoPrimary,
    insertDivergentVideo,

    /**
     * Write a completed video variant. Routes to a divergent alternate when:
     *   1. **Within-run drift**: caller passes `currentHash` and it differs
     *      from `inputHash` (the trigger-time snapshot) — upstream inputs
     *      changed between trigger and write.
     *   2. **Across-run drift**: an existing completed primary has a
     *      different `inputHash` — a previous run's output differs from this
     *      one's inputs.
     * Otherwise upserts the primary in place. The divergent row's stored
     * `inputHash` is always the trigger-time snapshot (idempotent on retry of
     * the same workflow run). Callers should skip live `sequences.mergedVideo*`
     * updates when `divergent` is true.
     */
    writeVideoVariant: async (
      data: NewSequenceVideoVariant & {
        inputHash: string;
        currentHash?: string;
      }
    ): Promise<WriteVariantResult<SequenceVideoVariant>> => {
      const { currentHash, ...rest } = data;
      const withinRunDrift =
        currentHash !== undefined && currentHash !== rest.inputHash;
      const existing = await getVideoPrimary(rest.sequenceId, rest.workflow);
      const acrossRunDrift =
        existing !== null &&
        existing.status === 'completed' &&
        existing.inputHash !== null &&
        existing.inputHash !== rest.inputHash;
      if (withinRunDrift || acrossRunDrift) {
        const variant = await insertDivergentVideo({
          ...rest,
          divergedAt: new Date(),
        });
        return { variant, divergent: true };
      }
      const variant = await upsertVideoPrimary(rest);
      return { variant, divergent: false };
    },

    getVideoById: async (
      variantId: string
    ): Promise<SequenceVideoVariant | null> => {
      const result = await db
        .select()
        .from(sequenceVideoVariants)
        .where(eq(sequenceVideoVariants.id, variantId));
      return result.at(0) ?? null;
    },

    /**
     * Promote a video variant: copies its url/path onto the live
     * `sequences.mergedVideo*` columns. Existing UI keeps reading those.
     */
    promoteVideoVariant: async (variantId: string): Promise<void> => {
      const result = await db
        .select()
        .from(sequenceVideoVariants)
        .where(eq(sequenceVideoVariants.id, variantId));
      const variant = result.at(0);
      if (!variant) {
        throw new Error(`SequenceVideoVariant ${variantId} not found`);
      }
      await db
        .update(sequences)
        .set({
          mergedVideoUrl: variant.url,
          mergedVideoPath: variant.storagePath,
          mergedVideoStatus: 'completed',
          mergedVideoGeneratedAt: variant.generatedAt ?? new Date(),
          mergedVideoError: null,
          updatedAt: new Date(),
        })
        .where(eq(sequences.id, variant.sequenceId));
    },

    // ── Music variants ────────────────────────────────────────────────────
    listMusicBySequence: async (
      sequenceId: string
    ): Promise<SequenceMusicVariant[]> => {
      return db
        .select()
        .from(sequenceMusicVariants)
        .where(eq(sequenceMusicVariants.sequenceId, sequenceId));
    },

    getMusicPrimary,
    upsertMusicPrimary,
    insertDivergentMusic,

    /**
     * Write a completed music variant with the same divergence routing as
     * `writeVideoVariant`.
     */
    writeMusicVariant: async (
      data: NewSequenceMusicVariant & { inputHash: string }
    ): Promise<WriteVariantResult<SequenceMusicVariant>> => {
      const existing = await getMusicPrimary(data.sequenceId, data.model);
      const isDivergent =
        existing !== null &&
        existing.status === 'completed' &&
        existing.inputHash !== null &&
        existing.inputHash !== data.inputHash;
      if (isDivergent) {
        const variant = await insertDivergentMusic({
          ...data,
          divergedAt: new Date(),
        });
        return { variant, divergent: true };
      }
      const variant = await upsertMusicPrimary(data);
      return { variant, divergent: false };
    },

    getMusicById: async (
      variantId: string
    ): Promise<SequenceMusicVariant | null> => {
      const result = await db
        .select()
        .from(sequenceMusicVariants)
        .where(eq(sequenceMusicVariants.id, variantId));
      return result.at(0) ?? null;
    },

    /**
     * Promote a music variant: copies prompt/tags/url/path/model onto the
     * live `sequences.music*` columns.
     */
    promoteMusicVariant: async (variantId: string): Promise<void> => {
      const result = await db
        .select()
        .from(sequenceMusicVariants)
        .where(eq(sequenceMusicVariants.id, variantId));
      const variant = result.at(0);
      if (!variant) {
        throw new Error(`SequenceMusicVariant ${variantId} not found`);
      }
      await db
        .update(sequences)
        .set({
          musicUrl: variant.url,
          musicPath: variant.storagePath,
          musicPrompt: variant.prompt,
          musicTags: variant.tags,
          musicModel: variant.model,
          musicStatus: 'completed',
          musicGeneratedAt: variant.generatedAt ?? new Date(),
          musicError: null,
          updatedAt: new Date(),
        })
        .where(eq(sequences.id, variant.sequenceId));
    },
  };
}
