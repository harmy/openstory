/**
 * Scoped Shot Prompt Variants Sub-module
 *
 * Appends a new revision row to `shot_prompt_variants` and updates the
 * cached pointer column on `shots` (`imagePrompt` for visual prompts,
 * `motionPrompt` for motion prompts) plus the matching
 * `*_prompt_input_hash` column. The two writes are sequential, not
 * transactional — see `write` for the durability story.
 *
 * Callers go through these helpers instead of writing the cached column
 * directly so prompt history is never lost. Read-path (read the cached
 * column) is unchanged.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § prompt versioning.
 */

import type { MotionPromptParameters } from '@/lib/ai/scene-analysis.schema';
import type { Database } from '@/lib/db/client';
import { shotPromptVariants, shots, user } from '@/lib/db/schema';
import type {
  ShotPromptType,
  ShotPromptVariant,
  ShotPromptVariantComponents,
} from '@/lib/db/schema';
import { and, desc, eq, isNotNull, lte } from 'drizzle-orm';

type WriteShotPromptVariantBase = {
  shotId: string;
  promptType: ShotPromptType;
  text: string;
  components?: ShotPromptVariantComponents | null;
  parameters?: MotionPromptParameters | null;
  createdBy?: string | null;
};

/**
 * `inputHash` represents the upstream context (scene + style + narrowed
 * bibles + aspectRatio + analysisModel) that this prompt is aligned with,
 * regardless of who authored the text. AI-generated and regenerated rows
 * carry a real hash at the call site so the partial unique index can dedupe
 * retries; the helper may downgrade the persisted hash to null on
 * the force-regen fallback path (see `write` for details). User-edits also
 * carry the live hash captured at edit time so staleness detection keeps
 * working after a hand-typed prompt; null is permitted only when the
 * upstream context was uncomputable at write time (e.g. style deleted), in
 * which case the staleness function falls back to an earlier non-null row.
 *
 * Restored rows carry the source variant's hash + analysisModel verbatim so
 * the cached `*_prompt_input_hash` column keeps tracking the upstream context
 * that originally produced the prompt — restoring an old AI prompt must NOT
 * silently disable staleness detection. Both fields stay nullable for restored
 * rows to accommodate legacy user-edit variants written before this contract
 * landed (they have null hashes that we can't retroactively recompute).
 */
export type WriteShotPromptVariantInput = WriteShotPromptVariantBase &
  (
    | {
        source: 'ai-generated' | 'regenerated';
        inputHash: string;
        analysisModel: string;
      }
    | {
        source: 'user-edit';
        inputHash: string | null;
        analysisModel: string | null;
      }
    | {
        source: 'restored';
        inputHash: string | null;
        analysisModel: string | null;
      }
  );

const cachedColumnsForType = (promptType: ShotPromptType) =>
  promptType === 'visual'
    ? {
        text: shots.imagePrompt,
        hash: shots.visualPromptInputHash,
        textKey: 'imagePrompt' as const,
        hashKey: 'visualPromptInputHash' as const,
      }
    : {
        text: shots.motionPrompt,
        hash: shots.motionPromptInputHash,
        textKey: 'motionPrompt' as const,
        hashKey: 'motionPromptInputHash' as const,
      };

export function createShotPromptVariantsMethods(db: Database) {
  return {
    /**
     * Append a new prompt variant row and update the cached pointer on
     * `shots`. Returns the inserted (or pre-existing matching) row.
     *
     * Durability: the insert + update pair is sequential, not transactional.
     * The variant row is the source of truth; the cached column on `shots`
     * is a read-path optimization. To make retries safe, AI-generated
     * rows are deduped by the unique partial index on
     * `(shot_id, prompt_type, input_hash) WHERE input_hash IS NOT NULL`:
     * an insert that conflicts with an existing row no-ops, the existing row
     * is fetched, and the cached pointer is updated as normal.
     *
     * Force-regeneration corner case: an explicit user-triggered regen runs
     * the LLM against unchanged upstream inputs. The new completion's hash
     * matches an existing row, so the unique-index insert no-ops — but the
     * text genuinely differs. We append a fallback row with `input_hash =
     * NULL` (excluded by the partial index) so history records the new text;
     * the cached `*_prompt_input_hash` column still tracks the real
     * `liveHash` so staleness detection stays correct.
     */
    write: async (
      input: WriteShotPromptVariantInput
    ): Promise<ShotPromptVariant> => {
      const cached = cachedColumnsForType(input.promptType);

      const nextHash = input.inputHash;
      const analysisModel = input.analysisModel;

      // Append first so a crash can't leave a stale pointer with no row
      // behind it. The reverse order would be unrecoverable.
      const [inserted] = await db
        .insert(shotPromptVariants)
        .values({
          shotId: input.shotId,
          promptType: input.promptType,
          text: input.text,
          components: input.components,
          parameters: input.parameters,
          source: input.source,
          inputHash: nextHash,
          analysisModel,
          createdBy: input.createdBy ?? null,
        })
        .onConflictDoNothing()
        .returning();

      let variant: ShotPromptVariant | undefined = inserted;
      if (!variant && nextHash !== null) {
        const [existing] = await db
          .select()
          .from(shotPromptVariants)
          .where(
            and(
              eq(shotPromptVariants.shotId, input.shotId),
              eq(shotPromptVariants.promptType, input.promptType),
              eq(shotPromptVariants.inputHash, nextHash)
            )
          )
          .limit(1);

        if (
          existing &&
          existing.text !== input.text &&
          (input.source === 'ai-generated' || input.source === 'regenerated')
        ) {
          // Force-regen path: same upstream hash but a fresh LLM completion.
          // Bypass the partial unique index with a null `input_hash` so the
          // new text lands in history. Restore/user-edit paths never reach
          // this branch — they don't carry a non-null `inputHash` here.
          const [forced] = await db
            .insert(shotPromptVariants)
            .values({
              shotId: input.shotId,
              promptType: input.promptType,
              text: input.text,
              components: input.components,
              parameters: input.parameters,
              source: input.source,
              inputHash: null,
              analysisModel,
              createdBy: input.createdBy ?? null,
            })
            .returning();
          variant = forced;
        } else {
          variant = existing;
        }
      }

      if (!variant) {
        throw new Error('Failed to insert shot prompt variant');
      }

      await db
        .update(shots)
        .set({
          [cached.textKey]: input.text,
          [cached.hashKey]: nextHash,
          updatedAt: new Date(),
        })
        .where(eq(shots.id, input.shotId));

      return variant;
    },

    /** List the revision history for a shot's prompt, newest first. */
    listByShot: async (
      shotId: string,
      promptType: ShotPromptType
    ): Promise<ShotPromptVariant[]> => {
      return await db
        .select()
        .from(shotPromptVariants)
        .where(
          and(
            eq(shotPromptVariants.shotId, shotId),
            eq(shotPromptVariants.promptType, promptType)
          )
        )
        .orderBy(desc(shotPromptVariants.createdAt));
    },

    /**
     * History list for the UI — joins author name. Newest first.
     */
    listByShotWithAuthor: async (
      shotId: string,
      promptType: ShotPromptType
    ): Promise<Array<ShotPromptVariant & { createdByName: string | null }>> => {
      const rows = await db
        .select({ variant: shotPromptVariants, createdByName: user.name })
        .from(shotPromptVariants)
        .leftJoin(user, eq(shotPromptVariants.createdBy, user.id))
        .where(
          and(
            eq(shotPromptVariants.shotId, shotId),
            eq(shotPromptVariants.promptType, promptType)
          )
        )
        .orderBy(desc(shotPromptVariants.createdAt));
      return rows.map((r) => ({
        ...r.variant,
        createdByName: r.createdByName,
      }));
    },

    /** Fetch a single variant scoped to its shot. */
    getByIdForShot: async (
      variantId: string,
      shotId: string
    ): Promise<ShotPromptVariant | null> => {
      const [row] = await db
        .select()
        .from(shotPromptVariants)
        .where(
          and(
            eq(shotPromptVariants.id, variantId),
            eq(shotPromptVariants.shotId, shotId)
          )
        )
        .limit(1);
      return row ?? null;
    },

    /**
     * Candidates for matching a `shot_variants.promptHash` (`simpleHash` of
     * the prompt text) — pulls prompt variants of the right type that existed
     * at or before `cutoff`, newest first. Caller filters by simpleHash.
     */
    listCandidatesAtOrBefore: async (
      shotId: string,
      promptType: ShotPromptType,
      cutoff: Date,
      limit = 50
    ): Promise<ShotPromptVariant[]> => {
      return await db
        .select()
        .from(shotPromptVariants)
        .where(
          and(
            eq(shotPromptVariants.shotId, shotId),
            eq(shotPromptVariants.promptType, promptType),
            lte(shotPromptVariants.createdAt, cutoff)
          )
        )
        .orderBy(desc(shotPromptVariants.createdAt))
        .limit(limit);
    },

    /** Most recent variant of a given type, or null if none exists. */
    getLatest: async (
      shotId: string,
      promptType: ShotPromptType
    ): Promise<ShotPromptVariant | null> => {
      const [row] = await db
        .select()
        .from(shotPromptVariants)
        .where(
          and(
            eq(shotPromptVariants.shotId, shotId),
            eq(shotPromptVariants.promptType, promptType)
          )
        )
        .orderBy(desc(shotPromptVariants.createdAt))
        .limit(1);
      return row ?? null;
    },

    /**
     * Most recent variant of a given type whose `inputHash` is non-null.
     * Used by the staleness path to find a reference hash for legacy shots
     * whose cached `*_prompt_input_hash` column was nulled out by a
     * pre-fix user-edit. Skips user-edit rows that fell back to null when
     * context was uncomputable.
     */
    getLatestWithInputHash: async (
      shotId: string,
      promptType: ShotPromptType
    ): Promise<ShotPromptVariant | null> => {
      const [row] = await db
        .select()
        .from(shotPromptVariants)
        .where(
          and(
            eq(shotPromptVariants.shotId, shotId),
            eq(shotPromptVariants.promptType, promptType),
            isNotNull(shotPromptVariants.inputHash)
          )
        )
        .orderBy(desc(shotPromptVariants.createdAt))
        .limit(1);
      return row ?? null;
    },
  };
}
