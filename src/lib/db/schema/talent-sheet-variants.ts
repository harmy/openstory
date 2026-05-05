/**
 * Stores divergent talent-sheet outputs. Parent FK is `talent_sheets.id` so
 * each variant is scoped to a specific sheet — a talent may have many sheets
 * (e.g. "casual outfit", "formal wear"), each with its own divergent
 * alternates per model.
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
import { talentSheets } from './talent';

const TALENT_SHEET_VARIANT_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type TalentSheetVariantStatus =
  (typeof TALENT_SHEET_VARIANT_STATUSES)[number];

export const talentSheetVariants = sqliteTable(
  'talent_sheet_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    talentSheetId: text('talent_sheet_id')
      .notNull()
      .references(() => talentSheets.id, { onDelete: 'cascade' }),

    model: text('model', { length: 100 }).notNull(),

    url: text('url'),
    storagePath: text('storage_path'),

    status: text('status')
      .$type<TalentSheetVariantStatus>()
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
    index('idx_talent_sheet_variants_talent_sheet').on(table.talentSheetId),
    uniqueIndex('talent_sheet_variants_primary_key')
      .on(table.talentSheetId, table.model)
      .where(sql`${table.divergedAt} IS NULL`),
    uniqueIndex('talent_sheet_variants_divergent_key')
      .on(table.talentSheetId, table.model, table.inputHash)
      .where(sql`${table.divergedAt} IS NOT NULL`),
  ]
);

export type TalentSheetVariant = InferSelectModel<typeof talentSheetVariants>;
export type NewTalentSheetVariant = InferInsertModel<
  typeof talentSheetVariants
>;
