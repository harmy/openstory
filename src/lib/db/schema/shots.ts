/**
 * Shots Schema
 * Individual shots within a sequence
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { scenes } from './scenes';
import { sequences } from './sequences';

export const SHOT_GENERATION_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
type ShotGenerationStatus = (typeof SHOT_GENERATION_STATUSES)[number];

/**
 * Shots table
 * Individual shots within a sequence
 *
 * Each shot represents one scene from script analysis and stores:
 * - Visual content (thumbnailUrl for image, videoUrl for motion)
 * - Scene data in metadata field (populated progressively across 5 phases)
 * - Generation tracking information
 *
 * @see src/lib/ai/scene-analysis.schema.ts for Scene structure
 */
export const shots = snakeCase.table(
  'shots',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    // Parent scene (#907). NULL until backfilled. Deliberately NOT cascade —
    // CLAUDE.md rule 3: never cascade to long-lived parents; orphaned shots
    // null out rather than vanish if a scene is deleted.
    sceneId: text().references(() => scenes.id, { onDelete: 'set null' }),
    // 1-based shot order within the scene. Backfill sets this to 1 (every
    // sequence becomes scenes-of-one-shot until multi-shot analysis lands).
    shotNumber: integer(),
    orderIndex: integer().notNull(),
    description: text(),
    durationMs: integer().default(3000),
    thumbnailUrl: text(),
    previewThumbnailUrl: text(), // Fast preview CDN URL (not stored in R2; URL may expire but column persists)
    thumbnailPath: text(), // R2 storage path (not signed URL)
    variantImageUrl: text(), // R2 storage path (not signed URL)
    variantImageStatus: text().$type<ShotGenerationStatus>().default('pending'),
    variantWorkflowRunId: text(),
    variantImageGeneratedAt: integer({
      mode: 'timestamp',
    }),
    variantImageError: text(),
    videoUrl: text(),
    videoPath: text(), // R2 storage path (not signed URL)
    // Thumbnail generation status tracking
    thumbnailStatus: text().$type<ShotGenerationStatus>().default('pending'),
    thumbnailWorkflowRunId: text(),
    thumbnailGeneratedAt: integer({
      mode: 'timestamp',
    }),
    thumbnailError: text(),
    // SQL default pinned to the literal 'nano_banana_2' to match every deployed
    // DB's column default. DEFAULT_IMAGE_MODEL was bumped to 'gpt_image_2'
    // WITHOUT a migration; SQLite can't ALTER (or DROP) a column default without
    // a full table rebuild, which CASCADE-deletes child rows on D1 (the #612
    // trap). The shot-create path resolves the real default in app code; this
    // literal is just a never-relied-on fallback.
    imageModel: text({ length: 100 }).default('nano_banana_2').notNull(),
    imagePrompt: text(), // User-updated image prompt (overrides AI-generated prompt from metadata)
    // Video/motion generation status tracking
    videoStatus: text().$type<ShotGenerationStatus>().default('pending'),
    videoWorkflowRunId: text(),
    videoGeneratedAt: integer({
      mode: 'timestamp',
    }),
    videoError: text(),
    motionPrompt: text(), // User-updated motion prompt (overrides AI-generated prompt from metadata)
    motionModel: text({ length: 100 }), // Model used for motion/video generation (nullable - inherits from sequence if not set)
    // Audio/music generation status tracking
    audioUrl: text(),
    audioPath: text(), // R2 storage path (not signed URL)
    audioStatus: text().$type<ShotGenerationStatus>().default('pending'),
    audioWorkflowRunId: text(),
    audioGeneratedAt: integer({
      mode: 'timestamp',
    }),
    audioError: text(),
    audioModel: text({ length: 100 }), // Model used for music/audio generation (nullable)
    // SHA-256 of the inputs that produced each artifact; null when the
    // artifact has never been generated. See
    // docs/architecture/workflow-snapshots-and-content-hash-staleness.md.
    thumbnailInputHash: text(),
    variantImageInputHash: text(),
    videoInputHash: text(),
    audioInputHash: text(),
    // SHA-256 of the upstream context that produced the cached visual / motion
    // prompt (scene metadata + style config + character/location bible +
    // analysis model). When upstream context changes, the prompt itself is
    // flagged stale independently of the rendered image. Null when no AI
    // prompt has been generated yet, or when the most recent variant was a
    // user-edit (which has no upstream input surface).
    visualPromptInputHash: text(),
    motionPromptInputHash: text(),
    /**
     * Stores Scene data at various stages of progressive analysis.
     * Fields are populated progressively across 5 phases.
     * @see src/lib/ai/scene-analysis.schema.ts for Scene structure
     */
    metadata: text({ mode: 'json' }).$type<Scene>(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // Compound index for efficient ordering queries
    index('idx_shots_order').on(table.sequenceId, table.orderIndex),
    index('idx_shots_sequence_id').on(table.sequenceId),
    // Unique constraint: one shot per sequence/order combination
    uniqueIndex('shots_sequence_id_order_index_key').on(
      table.sequenceId,
      table.orderIndex
    ),
  ]
);

// Override the inferred Shot type to use Scene for metadata
type InferredShot = InferSelectModel<typeof shots>;
export type Shot = Omit<InferredShot, 'metadata'> & {
  metadata: Scene | null; // Nullable until script analysis completes, fields populate progressively
};

type InferredNewShot = InferInsertModel<typeof shots>;
export type NewShot = Omit<InferredNewShot, 'metadata'> & {
  metadata?: Scene | null; // Optional - can be null initially, populated during script analysis
};
