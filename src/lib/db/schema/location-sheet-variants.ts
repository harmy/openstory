/**
 * Location Sheet Variants Schema
 * Stores divergent location reference outputs (Stage 2 of workflow snapshots).
 *
 * Covers both sequence-scoped locations (`sequence_locations.referenceImageUrl`,
 * written by `locationSheetWorkflow`) and team-level library locations
 * (`location_library.referenceImageUrl`, written by
 * `libraryLocationSheetWorkflow`). The parent is type-tagged via
 * `parent_type` + `parent_id` so a single variants table services both
 * surfaces without duplicating columns.
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

export const LOCATION_SHEET_VARIANT_PARENT_TYPES = [
  'sequence_location',
  'library_location',
] as const;
export type LocationSheetVariantParentType =
  (typeof LOCATION_SHEET_VARIANT_PARENT_TYPES)[number];

const LOCATION_SHEET_VARIANT_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type LocationSheetVariantStatus =
  (typeof LOCATION_SHEET_VARIANT_STATUSES)[number];

export const locationSheetVariants = sqliteTable(
  'location_sheet_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    parentType: text('parent_type')
      .$type<LocationSheetVariantParentType>()
      .notNull(),
    parentId: text('parent_id').notNull(),

    model: text('model', { length: 100 }).notNull(),

    url: text('url'),
    storagePath: text('storage_path'),

    status: text('status')
      .$type<LocationSheetVariantStatus>()
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
    index('idx_location_sheet_variants_parent').on(
      table.parentType,
      table.parentId
    ),
    uniqueIndex('location_sheet_variants_primary_key')
      .on(table.parentType, table.parentId, table.model)
      .where(sql`${table.divergedAt} IS NULL`),
    uniqueIndex('location_sheet_variants_divergent_key')
      .on(table.parentType, table.parentId, table.model, table.inputHash)
      .where(sql`${table.divergedAt} IS NOT NULL`),
  ]
);

export type LocationSheetVariant = InferSelectModel<
  typeof locationSheetVariants
>;
export type NewLocationSheetVariant = InferInsertModel<
  typeof locationSheetVariants
>;
