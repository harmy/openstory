/**
 * Scoped Sequence Music Prompt Variants Sub-module
 *
 * Appends a new revision row to `sequence_music_prompt_variants` and
 * updates the cached `musicPrompt` / `musicTags` / `musicPromptInputHash`
 * columns on `sequences`. Sequential, not transactional — see the
 * equivalent docstring in `shot-prompt-variants.ts` for the durability
 * story.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § prompt versioning.
 */

import type { Database } from '@/lib/db/client';
import { sequenceMusicPromptVariants, sequences, user } from '@/lib/db/schema';
import type { SequenceMusicPromptVariant } from '@/lib/db/schema';
import { and, desc, eq } from 'drizzle-orm';

type WriteSequenceMusicPromptVariantBase = {
  sequenceId: string;
  prompt: string;
  tags?: string | null;
  createdBy?: string | null;
};

/**
 * AI-generated and regenerated rows must carry the upstream-context hash and
 * the analysis model that produced the prompt — without these, the cached
 * `musicPromptInputHash` column on `sequences` is meaningless and staleness
 * detection silently breaks. User-edits forbid both fields so they cannot be
 * set by mistake.
 *
 * Restored rows carry the source variant's hash + analysisModel verbatim so
 * the cached `musicPromptInputHash` column keeps tracking the upstream
 * context that originally produced the prompt — restoring an old AI prompt
 * must NOT silently disable staleness detection. Both fields can be null
 * when the source is itself a user-edit (which never had a hash).
 */
export type WriteSequenceMusicPromptVariantInput =
  WriteSequenceMusicPromptVariantBase &
    (
      | {
          source: 'ai-generated' | 'regenerated';
          inputHash: string;
          analysisModel: string;
        }
      | {
          source: 'user-edit';
          inputHash?: never;
          analysisModel?: never;
        }
      | {
          source: 'restored';
          inputHash: string | null;
          analysisModel: string | null;
        }
    );

export function createSequenceMusicPromptVariantsMethods(db: Database) {
  return {
    /**
     * Append a music prompt variant row and update the cached
     * `musicPrompt` / `musicTags` / `musicPromptInputHash` columns on
     * `sequences`. Returns the inserted (or pre-existing matching) row.
     *
     * AI-generated rows are deduped on a unique partial index
     * `(sequence_id, input_hash) WHERE input_hash IS NOT NULL` so QStash
     * retries don't append duplicate history.
     */
    write: async (
      input: WriteSequenceMusicPromptVariantInput
    ): Promise<SequenceMusicPromptVariant> => {
      const nextHash = input.source === 'user-edit' ? null : input.inputHash;
      const analysisModel =
        input.source === 'user-edit' ? null : input.analysisModel;

      const [inserted] = await db
        .insert(sequenceMusicPromptVariants)
        .values({
          sequenceId: input.sequenceId,
          prompt: input.prompt,
          tags: input.tags ?? null,
          source: input.source,
          inputHash: nextHash,
          analysisModel,
          createdBy: input.createdBy ?? null,
        })
        .onConflictDoNothing()
        .returning();

      let variant: SequenceMusicPromptVariant | undefined = inserted;
      if (!variant && nextHash !== null) {
        const [existing] = await db
          .select()
          .from(sequenceMusicPromptVariants)
          .where(
            and(
              eq(sequenceMusicPromptVariants.sequenceId, input.sequenceId),
              eq(sequenceMusicPromptVariants.inputHash, nextHash)
            )
          )
          .limit(1);
        variant = existing;
      }

      if (!variant) {
        throw new Error('Failed to insert sequence music prompt variant');
      }

      await db
        .update(sequences)
        .set({
          musicPrompt: input.prompt,
          musicTags: input.tags ?? null,
          musicPromptInputHash: nextHash,
          updatedAt: new Date(),
        })
        .where(eq(sequences.id, input.sequenceId));

      return variant;
    },

    /** Revision history for a sequence's music prompt, newest first. */
    listBySequence: async (
      sequenceId: string
    ): Promise<SequenceMusicPromptVariant[]> => {
      return await db
        .select()
        .from(sequenceMusicPromptVariants)
        .where(eq(sequenceMusicPromptVariants.sequenceId, sequenceId))
        .orderBy(desc(sequenceMusicPromptVariants.createdAt));
    },

    /** Most recent music prompt variant, or null if none exists. */
    getLatest: async (
      sequenceId: string
    ): Promise<SequenceMusicPromptVariant | null> => {
      const [row] = await db
        .select()
        .from(sequenceMusicPromptVariants)
        .where(eq(sequenceMusicPromptVariants.sequenceId, sequenceId))
        .orderBy(desc(sequenceMusicPromptVariants.createdAt))
        .limit(1);
      return row ?? null;
    },

    /** History list for the UI — joins author name. Newest first. */
    listBySequenceWithAuthor: async (
      sequenceId: string
    ): Promise<
      Array<SequenceMusicPromptVariant & { createdByName: string | null }>
    > => {
      const rows = await db
        .select({
          variant: sequenceMusicPromptVariants,
          createdByName: user.name,
        })
        .from(sequenceMusicPromptVariants)
        .leftJoin(user, eq(sequenceMusicPromptVariants.createdBy, user.id))
        .where(eq(sequenceMusicPromptVariants.sequenceId, sequenceId))
        .orderBy(desc(sequenceMusicPromptVariants.createdAt));
      return rows.map((r) => ({
        ...r.variant,
        createdByName: r.createdByName,
      }));
    },

    /** Fetch a single music prompt variant scoped to its sequence. */
    getByIdForSequence: async (
      variantId: string,
      sequenceId: string
    ): Promise<SequenceMusicPromptVariant | null> => {
      const [row] = await db
        .select()
        .from(sequenceMusicPromptVariants)
        .where(
          and(
            eq(sequenceMusicPromptVariants.id, variantId),
            eq(sequenceMusicPromptVariants.sequenceId, sequenceId)
          )
        )
        .limit(1);
      return row ?? null;
    },
  };
}
