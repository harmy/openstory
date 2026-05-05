/**
 * Scoped Character Sheet Variants Sub-module
 * CRUD for divergent character-sheet outputs (Stage 2 of workflow snapshots).
 */

import type { Database } from '@/lib/db/client';
import type {
  CharacterSheetVariant,
  NewCharacterSheetVariant,
} from '@/lib/db/schema';
import { characterSheetVariants, characters } from '@/lib/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { insertDivergentRaceTolerant } from './divergent-insert';

type PromoteCharacterUpdate = {
  sheetImageUrl: string | null;
  sheetImagePath: string | null;
  sheetInputHash: string | null;
};

export function createCharacterSheetVariantsMethods(db: Database) {
  return {
    listByCharacter: async (
      characterId: string
    ): Promise<CharacterSheetVariant[]> => {
      return db
        .select()
        .from(characterSheetVariants)
        .where(eq(characterSheetVariants.characterId, characterId));
    },

    listDivergentByCharacter: async (
      characterId: string
    ): Promise<CharacterSheetVariant[]> => {
      return db
        .select()
        .from(characterSheetVariants)
        .where(
          and(
            eq(characterSheetVariants.characterId, characterId),
            sql`${characterSheetVariants.divergedAt} IS NOT NULL`
          )
        );
    },

    /**
     * List active (non-discarded) divergent alternates for a character. The
     * UI banner / corner-dot reads through this so the surfaces clear once
     * the user discards or promotes.
     */
    listDivergentActiveByCharacter: async (
      characterId: string
    ): Promise<CharacterSheetVariant[]> => {
      return db
        .select()
        .from(characterSheetVariants)
        .where(
          and(
            eq(characterSheetVariants.characterId, characterId),
            sql`${characterSheetVariants.divergedAt} IS NOT NULL`,
            sql`${characterSheetVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(characterSheetVariants.divergedAt);
    },

    listDivergentActiveByCharacters: async (
      characterIds: string[]
    ): Promise<CharacterSheetVariant[]> => {
      if (characterIds.length === 0) return [];
      return db
        .select()
        .from(characterSheetVariants)
        .where(
          and(
            inArray(characterSheetVariants.characterId, characterIds),
            sql`${characterSheetVariants.divergedAt} IS NOT NULL`,
            sql`${characterSheetVariants.discardedAt} IS NULL`
          )
        )
        .orderBy(characterSheetVariants.divergedAt);
    },

    /**
     * Look up a variant by id. Used by the promote / discard server functions
     * to confirm the row exists and is still divergent before acting.
     */
    getById: async (
      variantId: string
    ): Promise<CharacterSheetVariant | null> => {
      const result = await db
        .select()
        .from(characterSheetVariants)
        .where(eq(characterSheetVariants.id, variantId));
      return result[0] ?? null;
    },

    insert: async (
      values: NewCharacterSheetVariant
    ): Promise<CharacterSheetVariant> => {
      const [row] = await db
        .insert(characterSheetVariants)
        .values(values)
        .returning();
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!row) {
        throw new Error('Failed to insert character sheet variant');
      }
      return row;
    },

    /**
     * Idempotent on (characterId, model, inputHash) within the divergent
     * partial unique index. Tolerant to two failure modes:
     *
     *  - QStash step retry: the row was inserted on a previous attempt, the
     *    pre-check returns it.
     *  - Cross-run race: two divergent runs both pass the pre-check, one
     *    INSERT loses; the helper re-fetches and returns the winner's row.
     *
     * Pre-check + retry-fetch is required because drizzle's SQLite
     * `onConflictDoNothing` does not emit the partial-index `WHERE` predicate
     * after the target column list, so SQLite does not match the divergent
     * partial unique index and the conflict raises instead of being absorbed.
     */
    insertDivergent: async (
      values: NewCharacterSheetVariant & {
        inputHash: string;
        divergedAt: Date;
      }
    ): Promise<CharacterSheetVariant> => {
      const findExisting = () =>
        db
          .select()
          .from(characterSheetVariants)
          .where(
            and(
              eq(characterSheetVariants.characterId, values.characterId),
              eq(characterSheetVariants.model, values.model),
              eq(characterSheetVariants.inputHash, values.inputHash),
              sql`${characterSheetVariants.divergedAt} IS NOT NULL`
            )
          );
      return insertDivergentRaceTolerant({
        findExisting,
        insert: () =>
          db.insert(characterSheetVariants).values(values).returning(),
        errorMessage: 'Failed to insert character sheet variant',
      });
    },

    /** Soft-delete a divergent alternate; preserves the row for the toast Undo. */
    discard: async (variantId: string): Promise<Date> => {
      const discardedAt = new Date();
      const result = await db
        .update(characterSheetVariants)
        .set({ discardedAt, updatedAt: discardedAt })
        .where(eq(characterSheetVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`CharacterSheetVariant ${variantId} not found`);
      }
      return discardedAt;
    },

    undiscard: async (variantId: string): Promise<void> => {
      const result = await db
        .update(characterSheetVariants)
        .set({ discardedAt: null, updatedAt: new Date() })
        .where(eq(characterSheetVariants.id, variantId))
        .returning();
      if (result.length === 0) {
        throw new Error(`CharacterSheetVariant ${variantId} not found`);
      }
    },

    /**
     * Single batch so a partial failure cannot leave the live primary updated
     * with the variant still appearing as divergent.
     */
    promoteAtomically: async (
      characterId: string,
      characterUpdate: PromoteCharacterUpdate,
      variantId: string
    ): Promise<{ discardedAt: Date }> => {
      const [existingCharacter] = await db
        .select({ id: characters.id })
        .from(characters)
        .where(eq(characters.id, characterId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!existingCharacter) {
        throw new Error(`Character ${characterId} not found`);
      }
      const [existingVariant] = await db
        .select({ id: characterSheetVariants.id })
        .from(characterSheetVariants)
        .where(eq(characterSheetVariants.id, variantId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!existingVariant) {
        throw new Error(`CharacterSheetVariant ${variantId} not found`);
      }

      const now = new Date();
      const updateCharacter = db
        .update(characters)
        .set({ ...characterUpdate, updatedAt: now })
        .where(eq(characters.id, characterId))
        .returning({ id: characters.id });
      const discardVariant = db
        .update(characterSheetVariants)
        .set({ discardedAt: now, updatedAt: now })
        .where(eq(characterSheetVariants.id, variantId))
        .returning({ id: characterSheetVariants.id });
      const [characterRows, variantRows] = await db.batch([
        updateCharacter,
        discardVariant,
      ]);
      if (characterRows.length === 0) {
        throw new Error(`Character ${characterId} disappeared during promote`);
      }
      if (variantRows.length === 0) {
        throw new Error(
          `CharacterSheetVariant ${variantId} disappeared during promote`
        );
      }
      return { discardedAt: now };
    },
  };
}
