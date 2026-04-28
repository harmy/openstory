/**
 * Location Sheets Schema
 * Alternative looks/variations for library locations
 * (e.g., same office but at night, during a party, after destruction)
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { locationLibrary } from './location-library';

const LOCATION_SHEET_SOURCES = [
  'manual_upload',
  'ai_generated',
  'from_library',
] as const;
export type LocationSheetSource = (typeof LOCATION_SHEET_SOURCES)[number];

/**
 * Location Sheets table
 * Stores different variations/looks for a library location
 * e.g., "daytime", "nighttime", "post-battle", "crowded"
 */
export const locationSheets = sqliteTable(
  'location_sheets',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    locationId: text('location_id')
      .notNull()
      .references(() => locationLibrary.id, { onDelete: 'cascade' }),
    name: text({ length: 255 }).notNull(), // e.g., "nighttime", "crowded"
    description: text(), // What makes this variation different
    imageUrl: text('image_url'),
    imagePath: text('image_path'), // R2 storage path
    isDefault: integer('is_default', { mode: 'boolean' }).default(false),
    source: text()
      .$type<LocationSheetSource>()
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
    index('idx_location_sheets_location_id').on(table.locationId),
    index('idx_location_sheets_is_default').on(table.isDefault),
  ]
);

// Type exports
export type LocationSheet = InferSelectModel<typeof locationSheets>;
export type NewLocationSheet = InferInsertModel<typeof locationSheets>;
