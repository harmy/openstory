/**
 * Stores divergent character-sheet outputs. When `characterSheetWorkflow`
 * finishes generating but its inputs have diverged from the live character
 * row, the result is saved here instead of overwriting
 * `characters.sheetImageUrl`.
 */

import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { characters } from './characters';

const CHARACTER_SHEET_VARIANT_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type CharacterSheetVariantStatus =
  (typeof CHARACTER_SHEET_VARIANT_STATUSES)[number];

export const characterSheetVariants = sqliteTable(
  'character_sheet_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    characterId: text('character_id')
      .notNull()
      .references(() => characters.id, { onDelete: 'cascade' }),

    model: text('model', { length: 100 }).notNull(),

    url: text('url'),
    storagePath: text('storage_path'),

    status: text('status')
      .$type<CharacterSheetVariantStatus>()
      .default('pending')
      .notNull(),
    workflowRunId: text('workflow_run_id'),
    generatedAt: integer('generated_at', { mode: 'timestamp' }),
    error: text('error'),

    inputHash: text('input_hash'),
    divergedAt: integer('diverged_at', { mode: 'timestamp' }),
    // Soft-delete marker; preserves the artifact for the toast Undo.
    discardedAt: integer('discarded_at', { mode: 'timestamp' }),

    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_character_sheet_variants_character').on(table.characterId),
    uniqueIndex('character_sheet_variants_primary_key')
      .on(table.characterId, table.model)
      .where(sql`${table.divergedAt} IS NULL`),
    uniqueIndex('character_sheet_variants_divergent_key')
      .on(table.characterId, table.model, table.inputHash)
      .where(sql`${table.divergedAt} IS NOT NULL`),
  ]
);

export type CharacterSheetVariant = InferSelectModel<
  typeof characterSheetVariants
>;
export type NewCharacterSheetVariant = InferInsertModel<
  typeof characterSheetVariants
>;
