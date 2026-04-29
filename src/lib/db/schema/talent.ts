/**
 * Talent Library Schema
 * Team-level talent (actors/actresses) library with multiple sheets and reference media
 */

import type { CharacterBibleEntry } from '@/lib/ai/scene-analysis.schema';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { user } from './auth';
import { teams } from './teams';

// ============================================================================
// Enums / Constants
// ============================================================================

const TALENT_SHEET_SOURCES = [
  'script_analysis',
  'manual_upload',
  'ai_generated',
] as const;
export type TalentSheetSource = (typeof TALENT_SHEET_SOURCES)[number];

const TALENT_MEDIA_TYPES = ['image', 'video', 'recording'] as const;
export type TalentMediaType = (typeof TALENT_MEDIA_TYPES)[number];

// ============================================================================
// Talent Table (Core Identity)
// ============================================================================

export const talent = sqliteTable(
  'talent',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    name: text({ length: 255 }).notNull(),
    description: text(),
    imageUrl: text('image_url'), // Talent avatar/headshot
    imagePath: text('image_path'), // R2 storage path for avatar
    isFavorite: integer('is_favorite', { mode: 'boolean' }).default(false),
    isHuman: integer('is_human', { mode: 'boolean' }).default(false),
    isInTeamLibrary: integer('is_in_team_library', { mode: 'boolean' }).default(
      false
    ),
    isPublic: integer('is_public', { mode: 'boolean' }).default(false),
    isTemplate: integer('is_template', { mode: 'boolean' }).default(false),
    createdBy: text('created_by').references(() => user.id, {
      onDelete: 'set null',
    }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_talent_team_id').on(table.teamId),
    index('idx_talent_name').on(table.name),
    index('idx_talent_is_favorite').on(table.isFavorite),
    index('idx_talent_is_in_team_library').on(table.isInTeamLibrary),
  ]
);

// ============================================================================
// Talent Sheets Table (Different Looks/Appearances)
// ============================================================================

export const talentSheets = sqliteTable(
  'talent_sheets',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    talentId: text('talent_id')
      .notNull()
      .references(() => talent.id, { onDelete: 'cascade' }),
    name: text({ length: 255 }).notNull(), // e.g., "casual outfit", "formal wear"
    imageUrl: text('image_url'),
    imagePath: text('image_path'), // R2 storage path
    metadata: text({ mode: 'json' }).$type<CharacterBibleEntry>(), // Full character details
    isDefault: integer('is_default', { mode: 'boolean' }).default(false),
    source: text()
      .$type<TalentSheetSource>()
      .default('manual_upload')
      .notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_talent_sheets_talent_id').on(table.talentId),
    index('idx_talent_sheets_is_default').on(table.isDefault),
  ]
);

// ============================================================================
// Talent Media Table (User Uploaded References)
// ============================================================================

export const talentMedia = sqliteTable(
  'talent_media',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    talentId: text('talent_id')
      .notNull()
      .references(() => talent.id, { onDelete: 'cascade' }),
    type: text().$type<TalentMediaType>().notNull(),
    url: text().notNull(),
    path: text(), // R2 storage path
    metadata: text({ mode: 'json' })
      .$type<Record<string, object>>()
      .default({}),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_talent_media_talent_id').on(table.talentId),
    index('idx_talent_media_type').on(table.type),
  ]
);

// ============================================================================
// Type Exports
// ============================================================================

export type Talent = InferSelectModel<typeof talent>;
export type NewTalent = InferInsertModel<typeof talent>;

export type TalentSheet = InferSelectModel<typeof talentSheets>;
export type NewTalentSheet = InferInsertModel<typeof talentSheets>;

export type TalentMediaRecord = InferSelectModel<typeof talentMedia>;
export type NewTalentMedia = InferInsertModel<typeof talentMedia>;

// Composite types for API responses
export type TalentWithSheets = Talent & {
  sheets: TalentSheet[];
  sheetCount: number;
  defaultSheet: TalentSheet | null;
};

export type TalentWithRelations = Talent & {
  sheets: TalentSheet[];
  media: TalentMediaRecord[];
};
