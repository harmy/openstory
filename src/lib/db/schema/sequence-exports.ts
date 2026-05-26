/**
 * Sequence Exports Schema
 *
 * A flat list of MP4 snapshots the user explicitly created via the browser-side
 * export pipeline (see `src/lib/sequence-player/export.ts`). Unlike the old
 * `sequence_video_variants` table, there is no primary/divergent split — every
 * row is just a snapshot at a point in time. The newest row (per sequence) is
 * what the "Download" UI surfaces.
 *
 * `sourceFramesHash` / `sourceMusicVariantId` are recorded so the UI can show
 * whether the most recent export is still in sync with current inputs.
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, snakeCase, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { sequences } from './sequences';

export const sequenceExports = snakeCase.table(
  'sequence_exports',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      // Intentionally NOT cascade — see CLAUDE.md "D1 / Turso table-rebuild
      // trap". Exports are cheap to keep around; cleanup runs in app code.
      .references(() => sequences.id, { onDelete: 'restrict' }),

    // Output
    url: text().notNull(),
    storagePath: text().notNull(),
    durationSeconds: integer(),

    // Inputs that produced this snapshot (for staleness display)
    sourceFramesHash: text(),
    sourceMusicVariantId: text(),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_sequence_exports_sequence').on(table.sequenceId),
    index('idx_sequence_exports_created_at').on(table.createdAt),
  ]
);

export type SequenceExport = InferSelectModel<typeof sequenceExports>;
export type NewSequenceExport = InferInsertModel<typeof sequenceExports>;
