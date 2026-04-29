/**
 * Location Library Schema
 * Team-level location templates for visual consistency across sequences
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { user } from './auth';
import { teams } from './teams';

/**
 * Location Library table
 * Team-level location templates that can be linked to sequence locations for visual consistency
 */
export const locationLibrary = sqliteTable(
  'location_library',
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
    // Reference image (establishing shot / mood board)
    referenceImageUrl: text('reference_image_url'),
    referenceImagePath: text('reference_image_path'), // R2 storage path
    isPublic: integer('is_public', { mode: 'boolean' }).default(false),
    isTemplate: integer('is_template', { mode: 'boolean' }).default(false),
    // Tracking
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
    index('idx_location_library_team_id').on(table.teamId),
    index('idx_location_library_name').on(table.name),
  ]
);

// Type exports
export type LibraryLocation = InferSelectModel<typeof locationLibrary>;
export type NewLibraryLocation = InferInsertModel<typeof locationLibrary>;

// Minimal type for API responses
export type LibraryLocationMinimal = Pick<
  LibraryLocation,
  'id' | 'name' | 'description' | 'referenceImageUrl'
>;
