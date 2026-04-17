/**
 * Sequences Schema
 * Core content creation entities for video sequences
 */

import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL } from '@/lib/ai/models';
import {
  type AspectRatio,
  DEFAULT_ASPECT_RATIO,
} from '@/lib/constants/aspect-ratios';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { user } from './auth';
// NOTE: frames imported in index.ts to avoid circular dependency
// frames.ts imports sequences for foreign key reference
import { styles } from './libraries';
import { teams } from './teams';

// Enum values as constants (SQLite doesn't have native enums)
const SEQUENCE_STATUSES = [
  'draft',
  'processing',
  'completed',
  'failed',
  'archived',
] as const;
export type SequenceStatus = (typeof SEQUENCE_STATUSES)[number];

const MERGED_VIDEO_STATUSES = [
  'pending',
  'merging',
  'completed',
  'failed',
] as const;
export type MergedVideoStatus = (typeof MERGED_VIDEO_STATUSES)[number];

const MUSIC_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type MusicStatus = (typeof MUSIC_STATUSES)[number];

/**
 * Sequences table
 * Main video sequence/project entity
 */
export const sequences = sqliteTable(
  'sequences',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    title: text({ length: 500 }).notNull(),
    script: text(),
    status: text().$type<SequenceStatus>().default('draft').notNull(),
    statusError: text('status_error'),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text('created_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    updatedBy: text('updated_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    styleId: text('style_id')
      .notNull()
      .references(() => styles.id, { onDelete: 'set null' }),
    aspectRatio: text('aspect_ratio', { length: 10 })
      .$type<AspectRatio>()
      .default(DEFAULT_ASPECT_RATIO)
      .notNull(),
    analysisModel: text('analysis_model', { length: 100 })
      .default('anthropic/claude-haiku-4.5')
      .notNull(),
    analysisDurationMs: integer('analysis_duration_ms').default(0).notNull(),
    imageModel: text('image_model', { length: 100 })
      .default(DEFAULT_IMAGE_MODEL)
      .notNull(),
    videoModel: text('video_model', { length: 100 })
      .default(DEFAULT_VIDEO_MODEL)
      .notNull(),
    workflow: text('workflow', { length: 100 }),

    // Merged video fields (final stitched video from all frames)
    mergedVideoUrl: text('merged_video_url'),
    mergedVideoPath: text('merged_video_path'),
    mergedVideoStatus: text('merged_video_status')
      .$type<MergedVideoStatus>()
      .default('pending'),
    mergedVideoGeneratedAt: integer('merged_video_generated_at', {
      mode: 'timestamp',
    }),
    mergedVideoError: text('merged_video_error'),

    // Music track fields (sequence-level background music)
    musicUrl: text('music_url'),
    musicPath: text('music_path'),
    musicStatus: text('music_status').$type<MusicStatus>().default('pending'),
    musicGeneratedAt: integer('music_generated_at', {
      mode: 'timestamp',
    }),
    musicError: text('music_error'),
    musicModel: text('music_model', { length: 100 }),
    musicPrompt: text('music_prompt'),
    musicTags: text('music_tags'),

    // Poster image (sequence-level preview from script, ephemeral CDN URL)
    posterUrl: text('poster_url'),

    // Auto-generation flags (set at sequence creation, read by UI for phase display)
    autoGenerateMotion: integer('auto_generate_motion', { mode: 'boolean' })
      .default(false)
      .notNull(),
    autoGenerateMusic: integer('auto_generate_music', { mode: 'boolean' })
      .default(false)
      .notNull(),

    // Suggested talent/location IDs used during generation (for pre-populating the UI)
    suggestedTalentIds: text('suggested_talent_ids', {
      mode: 'json',
    }).$type<string[]>(),
    suggestedLocationIds: text('suggested_location_ids', {
      mode: 'json',
    }).$type<string[]>(),
  },
  (table) => [
    index('idx_sequences_created_at').on(table.createdAt),
    index('idx_sequences_status').on(table.status),
    index('idx_sequences_style_id').on(table.styleId),
    index('idx_sequences_team_id').on(table.teamId),
  ]
);

// NOTE: sequencesRelations is defined in index.ts to avoid circular dependency
// (frames.ts imports sequences for FK reference, sequences needs frames for relations)

// Type exports
export type Sequence = InferSelectModel<typeof sequences>;
export type NewSequence = InferInsertModel<typeof sequences>;
