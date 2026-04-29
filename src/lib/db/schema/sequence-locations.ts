/**
 * Sequence Locations Schema
 * Locations extracted from scripts for visual consistency within a sequence
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
import { locationLibrary } from './location-library';
import { sequences } from './sequences';

const REFERENCE_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
export type ReferenceStatus = (typeof REFERENCE_STATUSES)[number];

/**
 * Sequence Locations table
 * Stores locations extracted from a sequence's script with their generated reference images
 */
export const sequenceLocations = sqliteTable(
  'sequence_locations',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    // Sequence association (required - all sequence locations belong to a sequence)
    sequenceId: text('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    // Optional link to library location for visual consistency
    libraryLocationId: text('library_location_id').references(
      () => locationLibrary.id,
      { onDelete: 'set null' }
    ),
    // From script analysis
    locationId: text('location_id').notNull(), // e.g. "loc_001" from script analysis
    name: text({ length: 255 }).notNull(), // e.g. "INT. OFFICE - DAY"
    // Flattened location bible fields
    type: text(), // interior, exterior, both
    timeOfDay: text('time_of_day'), // day, night, dusk, dawn
    description: text(), // Detailed visual description
    architecturalStyle: text('architectural_style'), // modern, industrial, vintage
    keyFeatures: text('key_features'), // Notable elements (e.g., "large windows, exposed brick")
    colorPalette: text('color_palette'), // Dominant colors
    lightingSetup: text('lighting_setup'), // e.g., "harsh overhead fluorescent"
    ambiance: text(), // e.g., "tense, corporate"
    consistencyTag: text('consistency_tag'), // e.g. "loc_001: office-modern-steel"
    // First appearance in script
    firstMentionSceneId: text('first_mention_scene_id'),
    firstMentionText: text('first_mention_text'),
    firstMentionLine: integer('first_mention_line'),
    // Reference image (establishing shot / mood board)
    referenceImageUrl: text('reference_image_url'),
    referenceImagePath: text('reference_image_path'), // R2 storage path
    // Generation status tracking
    referenceStatus: text('reference_status')
      .$type<ReferenceStatus>()
      .default('pending')
      .notNull(),
    referenceGeneratedAt: integer('reference_generated_at', {
      mode: 'timestamp',
    }),
    referenceError: text('reference_error'),
    // Timestamps
    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_sequence_locations_sequence_id').on(table.sequenceId),
    index('idx_sequence_locations_library_location_id').on(
      table.libraryLocationId
    ),
    // Unique constraint: one location per sequence/locationId combination
    // Note: locationId is from script analysis (e.g. "loc_001")
    uniqueIndex('sequence_locations_sequence_location_key').on(
      table.sequenceId,
      table.locationId
    ),
  ]
);

// Type exports
export type SequenceLocation = InferSelectModel<typeof sequenceLocations>;
export type NewSequenceLocation = InferInsertModel<typeof sequenceLocations>;

export type SequenceLocationMinimal = Pick<
  SequenceLocation,
  | 'id'
  | 'locationId'
  | 'name'
  | 'referenceImageUrl'
  | 'referenceStatus'
  | 'description'
  | 'consistencyTag'
>;

// Composite types for API responses
export type SequenceLocationWithDetails = SequenceLocation & {
  frameCount?: number;
  libraryLocation?: {
    id: string;
    name: string;
    referenceImageUrl: string | null;
  } | null;
};
