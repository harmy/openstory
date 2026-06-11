/**
 * Library Resources Schema
 * Styles, characters, VFX, and audio assets for teams
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import z from 'zod';
import { generateId } from '../id';
import { user } from './auth';
import { teams } from './teams';

export const StyleConfigSchema = z.object({
  mood: z.string().min(3).max(1000),
  artStyle: z.string().min(3).max(1000),
  lighting: z.string().min(3).max(1000),
  colorPalette: z.array(z.string().min(1)).min(1).max(20),
  cameraWork: z.string().min(3).max(1000),
  referenceFilms: z.array(z.string().min(1)).max(50),
  colorGrading: z.string().min(3).max(1000),
});

export type StyleConfig = z.infer<typeof StyleConfigSchema>;

const StyleSampleVideoKindSchema = z.enum(['canonical', 'category', 'bespoke']);

export const StyleSampleVideoSchema = z.object({
  url: z.string().url(),
  kind: StyleSampleVideoKindSchema,
  label: z.string(),
  durationSeconds: z.number().nonnegative(),
  order: z.number().int().nonnegative(),
});
export type StyleSampleVideo = z.infer<typeof StyleSampleVideoSchema>;

/**
 * Styles library
 * Style Stacks - JSON configurations for consistent AI-generated content
 */
export const styles = snakeCase.table(
  'styles',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text({ length: 255 }).notNull(),
    description: text(),
    config: text({ mode: 'json' }).$type<StyleConfig>().notNull(),
    category: text({ length: 100 }),
    // SQLite doesn't have array type - store as JSON array
    tags: text({ mode: 'json' })
      .$type<string[]>()
      .$defaultFn(() => []),
    isPublic: integer({ mode: 'boolean' }).default(false),
    isTemplate: integer({ mode: 'boolean' }).default(false),
    version: integer().default(1),
    previewUrl: text(),
    sampleVideos: text({ mode: 'json' })
      .$type<StyleSampleVideo[]>()
      .$defaultFn(() => []),
    recommendedImageModel: text(),
    recommendedVideoModel: text(),
    defaultAspectRatio: text(),
    useCases: text({ mode: 'json' })
      .$type<string[]>()
      .$defaultFn(() => []),
    sortOrder: integer().default(100),
    usageCount: integer().default(0),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [index('idx_styles_team_id').on(table.teamId)]
);

/**
 * VFX library
 * Visual effects presets and configurations
 */
export const vfx = snakeCase.table(
  'vfx',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text({ length: 255 }).notNull(),
    presetConfig: text({ mode: 'json' }).default('{}').notNull(),
    previewUrl: text(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('idx_vfx_name').on(table.name),
    index('idx_vfx_team_id').on(table.teamId),
  ]
);

/**
 * Audio library
 * Sound effects and music tracks
 */
export const audio = snakeCase.table(
  'audio',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text({ length: 255 }).notNull(),
    fileUrl: text().notNull(),
    durationMs: integer(),
    metadata: text({ mode: 'json' }).default('{}'),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('idx_audio_name').on(table.name),
    index('idx_audio_team_id').on(table.teamId),
  ]
);

// Type exports
export type Style = InferSelectModel<typeof styles>;
export type NewStyle = InferInsertModel<typeof styles>;

export type Vfx = InferSelectModel<typeof vfx>;

export type Audio = InferSelectModel<typeof audio>;
