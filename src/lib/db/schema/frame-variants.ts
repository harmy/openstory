/**
 * Frame Variants Schema
 * Stores per-model generation outputs for frames.
 * Each frame can have multiple variants (one per model per type),
 * enabling users to compare outputs from different AI models.
 */

import {
  type InferInsertModel,
  type InferSelectModel,
  relations,
} from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { FRAME_GENERATION_STATUSES } from './frames';
import { frames } from './frames';
import { sequences } from './sequences';

type FrameGenerationStatus = (typeof FRAME_GENERATION_STATUSES)[number];

export const VARIANT_TYPES = ['image', 'video', 'audio'] as const;
export type VariantType = (typeof VARIANT_TYPES)[number];

export const frameVariants = sqliteTable(
  'frame_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    frameId: text('frame_id')
      .notNull()
      .references(() => frames.id, { onDelete: 'cascade' }),
    sequenceId: text('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    variantType: text('variant_type').$type<VariantType>().notNull(),

    // Model identification
    model: text('model', { length: 100 }).notNull(),

    // Output URLs and storage paths
    url: text('url'),
    storagePath: text('storage_path'),
    previewUrl: text('preview_url'),

    // Shot variant (3x3 grid image generated from this model's output)
    shotVariantUrl: text('shot_variant_url'),
    shotVariantPath: text('shot_variant_path'),
    shotVariantStatus: text('shot_variant_status')
      .$type<FrameGenerationStatus>()
      .default('pending'),
    shotVariantWorkflowRunId: text('shot_variant_workflow_run_id'),

    // Generation tracking
    status: text('status')
      .$type<FrameGenerationStatus>()
      .default('pending')
      .notNull(),
    workflowRunId: text('workflow_run_id'),
    generatedAt: integer('generated_at', { mode: 'timestamp' }),
    error: text('error'),

    // Staleness detection
    promptHash: text('prompt_hash'),

    // Duration (relevant for video/audio variants)
    durationMs: integer('duration_ms'),

    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_frame_variants_frame_type').on(table.frameId, table.variantType),
    index('idx_frame_variants_sequence_type').on(
      table.sequenceId,
      table.variantType
    ),
    uniqueIndex('frame_variants_frame_type_model_key').on(
      table.frameId,
      table.variantType,
      table.model
    ),
  ]
);

export const frameVariantsRelations = relations(frameVariants, ({ one }) => ({
  frame: one(frames, {
    fields: [frameVariants.frameId],
    references: [frames.id],
  }),
  sequence: one(sequences, {
    fields: [frameVariants.sequenceId],
    references: [sequences.id],
  }),
}));

export type FrameVariant = InferSelectModel<typeof frameVariants>;
export type NewFrameVariant = InferInsertModel<typeof frameVariants>;
