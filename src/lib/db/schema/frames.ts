/**
 * Frames Schema
 * Individual frames/shots within a sequence
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { sequences } from './sequences';

export const FRAME_GENERATION_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
type FrameGenerationStatus = (typeof FRAME_GENERATION_STATUSES)[number];

/**
 * Frames table
 * Individual frames/shots within a sequence
 *
 * Each frame represents one scene from script analysis and stores:
 * - Visual content (thumbnailUrl for image, videoUrl for motion)
 * - Scene data in metadata field (populated progressively across 5 phases)
 * - Generation tracking information
 *
 * @see src/lib/ai/scene-analysis.schema.ts for Scene structure
 */
export const frames = sqliteTable(
  'frames',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    orderIndex: integer('order_index').notNull(),
    description: text(),
    durationMs: integer('duration_ms').default(3000),
    thumbnailUrl: text('thumbnail_url'),
    previewThumbnailUrl: text('preview_thumbnail_url'), // Fast preview CDN URL (not stored in R2; URL may expire but column persists)
    thumbnailPath: text('thumbnail_path'), // R2 storage path (not signed URL)
    variantImageUrl: text('variant_image_url'), // R2 storage path (not signed URL)
    variantImageStatus: text('variant_image_status')
      .$type<FrameGenerationStatus>()
      .default('pending'),
    variantWorkflowRunId: text('variant_workflow_run_id'),
    videoUrl: text('video_url'),
    videoPath: text('video_path'), // R2 storage path (not signed URL)
    // Thumbnail generation status tracking
    thumbnailStatus: text('thumbnail_status')
      .$type<FrameGenerationStatus>()
      .default('pending'),
    thumbnailWorkflowRunId: text('thumbnail_workflow_run_id'),
    thumbnailGeneratedAt: integer('thumbnail_generated_at', {
      mode: 'timestamp',
    }),
    thumbnailError: text('thumbnail_error'),
    imageModel: text('image_model', { length: 100 })
      .default(DEFAULT_IMAGE_MODEL)
      .notNull(), // Model used for image generation
    imagePrompt: text('image_prompt'), // User-updated image prompt (overrides AI-generated prompt from metadata)
    // Video/motion generation status tracking
    videoStatus: text('video_status')
      .$type<FrameGenerationStatus>()
      .default('pending'),
    videoWorkflowRunId: text('video_workflow_run_id'),
    videoGeneratedAt: integer('video_generated_at', {
      mode: 'timestamp',
    }),
    videoError: text('video_error'),
    motionPrompt: text('motion_prompt'), // User-updated motion prompt (overrides AI-generated prompt from metadata)
    motionModel: text('motion_model', { length: 100 }), // Model used for motion/video generation (nullable - inherits from sequence if not set)
    // Audio/music generation status tracking
    audioUrl: text('audio_url'),
    audioPath: text('audio_path'), // R2 storage path (not signed URL)
    audioStatus: text('audio_status')
      .$type<FrameGenerationStatus>()
      .default('pending'),
    audioWorkflowRunId: text('audio_workflow_run_id'),
    audioGeneratedAt: integer('audio_generated_at', {
      mode: 'timestamp',
    }),
    audioError: text('audio_error'),
    audioModel: text('audio_model', { length: 100 }), // Model used for music/audio generation (nullable)
    /**
     * Stores Scene data at various stages of progressive analysis.
     * Fields are populated progressively across 5 phases.
     * @see src/lib/ai/scene-analysis.schema.ts for Scene structure
     */
    metadata: text({ mode: 'json' }).$type<Scene>(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // Compound index for efficient ordering queries
    index('idx_frames_order').on(table.sequenceId, table.orderIndex),
    index('idx_frames_sequence_id').on(table.sequenceId),
    // Unique constraint: one frame per sequence/order combination
    uniqueIndex('frames_sequence_id_order_index_key').on(
      table.sequenceId,
      table.orderIndex
    ),
  ]
);

// Override the inferred Frame type to use Scene for metadata
type InferredFrame = InferSelectModel<typeof frames>;
export type Frame = Omit<InferredFrame, 'metadata'> & {
  metadata: Scene | null; // Nullable until script analysis completes, fields populate progressively
};

type InferredNewFrame = InferInsertModel<typeof frames>;
export type NewFrame = Omit<InferredNewFrame, 'metadata'> & {
  metadata?: Scene | null; // Optional - can be null initially, populated during script analysis
};
