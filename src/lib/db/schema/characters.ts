/**
 * Characters Schema
 * Scripted characters (roles) extracted from scripts, linked to talent for casting
 */

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
import { talent } from './talent';

const SHEET_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type SheetStatus = (typeof SHEET_STATUSES)[number];

/**
 * Characters table
 * Stores characters extracted from a sequence's script with their generated reference sheets
 * and optional casting assignment to talent
 */
export const characters = sqliteTable(
  'characters',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    // Casting assignment (which talent plays this character)
    talentId: text('talent_id').references(() => talent.id, {
      onDelete: 'set null',
    }),
    // From script analysis
    characterId: text('character_id').notNull(), // e.g. "char_001" from script analysis
    name: text({ length: 255 }).notNull(),
    // Flattened character bible fields (previously in metadata JSON)
    age: text().notNull(), // Can be "30s" or "35"
    gender: text(),
    ethnicity: text(),
    physicalDescription: text('physical_description'),
    standardClothing: text('standard_clothing'),
    distinguishingFeatures: text('distinguishing_features'),
    consistencyTag: text('consistency_tag'), // e.g. "char_001: Jack-denim-jacket"
    // First appearance in script
    firstMentionSceneId: text('first_mention_scene_id'),
    firstMentionText: text('first_mention_text'),
    firstMentionLine: integer('first_mention_line'),
    // Character sheet image (full body turnaround)
    sheetImageUrl: text('sheet_image_url'),
    sheetImagePath: text('sheet_image_path'), // R2 storage path
    // Generation status tracking
    sheetStatus: text('sheet_status')
      .$type<SheetStatus>()
      .default('pending')
      .notNull(),
    sheetGeneratedAt: integer('sheet_generated_at', { mode: 'timestamp' }),
    sheetError: text('sheet_error'),
    // Timestamps
    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_characters_sequence_id').on(table.sequenceId),
    index('idx_characters_talent_id').on(table.talentId),
    // Unique constraint: one character per sequence/characterId combination
    uniqueIndex('characters_sequence_character_key').on(
      table.sequenceId,
      table.characterId
    ),
  ]
);

// Type exports
export type Character = InferSelectModel<typeof characters>;
export type NewCharacter = InferInsertModel<typeof characters>;

export type CharacterMinimal = Pick<
  Character,
  | 'id'
  | 'characterId'
  | 'name'
  | 'sheetImageUrl'
  | 'sheetStatus'
  | 'physicalDescription'
  | 'consistencyTag'
>;

// Composite types for API responses
export type CharacterWithTalent = Character & {
  talent: {
    id: string;
    name: string;
    imageUrl: string | null;
  } | null;
};
