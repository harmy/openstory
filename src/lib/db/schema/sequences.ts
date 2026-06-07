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
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
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
export const sequences = snakeCase.table(
  'sequences',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    title: text({ length: 500 }).notNull(),
    script: text(),
    status: text().$type<SequenceStatus>().default('draft').notNull(),
    statusError: text(),
    // CF Workflows instance id of the most recent /storyboard run. Lets the
    // cron reconciler (reconcile-all.ts) verify a stuck 'processing' row
    // against the instance's real status instead of leaving it spinning
    // forever when the workflow dies without persisting an outcome (#839).
    workflowRunId: text({ length: 100 }),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
    updatedBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
    styleId: text()
      .notNull()
      .references(() => styles.id, { onDelete: 'set null' }),
    aspectRatio: text({ length: 10 })
      .$type<AspectRatio>()
      .default(DEFAULT_ASPECT_RATIO)
      .notNull(),
    analysisModel: text({ length: 100 })
      .default('anthropic/claude-haiku-4.5')
      .notNull(),
    analysisDurationMs: integer().default(0).notNull(),
    imageModel: text({ length: 100 }).default(DEFAULT_IMAGE_MODEL).notNull(),
    videoModel: text({ length: 100 }).default(DEFAULT_VIDEO_MODEL).notNull(),
    workflow: text({ length: 100 }),

    // Music track fields (sequence-level background music)
    musicUrl: text(),
    musicPath: text(),
    musicStatus: text().$type<MusicStatus>().default('pending'),
    musicGeneratedAt: integer({
      mode: 'timestamp',
    }),
    musicError: text(),
    musicModel: text({ length: 100 }),
    musicPrompt: text(),
    musicTags: text(),
    // SHA-256 of the upstream context that produced the cached AI music
    // prompt (musicDesign + analysis model). Null when no AI prompt has been
    // generated yet, or when the most recent variant was a user-edit.
    musicPromptInputHash: text(),

    // Poster image (sequence-level preview from script, ephemeral CDN URL)
    posterUrl: text(),

    // Auto-generation flags (set at sequence creation, read by UI for phase display)
    autoGenerateMotion: integer({ mode: 'boolean' }).default(false).notNull(),
    autoGenerateMusic: integer({ mode: 'boolean' }).default(false).notNull(),

    // Suggested talent/location IDs used during generation (for pre-populating the UI)
    suggestedTalentIds: text({
      mode: 'json',
    }).$type<string[]>(),
    suggestedLocationIds: text({
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

// Type exports
export type Sequence = InferSelectModel<typeof sequences>;
export type NewSequence = InferInsertModel<typeof sequences>;
