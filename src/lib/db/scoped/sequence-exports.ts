/**
 * Scoped sequence_exports CRUD. Exports are flat — no primary/divergent
 * split — and rows accumulate. The newest row per sequence is what the UI
 * surfaces as "your latest download".
 */

import type { Database } from '@/lib/db/client';
import {
  sequenceExports,
  type NewSequenceExport,
  type SequenceExport,
} from '@/lib/db/schema';
import { desc, eq } from 'drizzle-orm';

export function createSequenceExportsMethods(db: Database) {
  return {
    /** Newest-first list of every export ever taken for `sequenceId`. */
    listBySequence: async (sequenceId: string): Promise<SequenceExport[]> => {
      return await db
        .select()
        .from(sequenceExports)
        .where(eq(sequenceExports.sequenceId, sequenceId))
        .orderBy(desc(sequenceExports.createdAt));
    },

    getLatest: async (sequenceId: string): Promise<SequenceExport | null> => {
      const rows = await db
        .select()
        .from(sequenceExports)
        .where(eq(sequenceExports.sequenceId, sequenceId))
        .orderBy(desc(sequenceExports.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },

    insert: async (input: NewSequenceExport): Promise<SequenceExport> => {
      const [row] = await db.insert(sequenceExports).values(input).returning();
      if (!row) throw new Error('Failed to insert sequence export');
      return row;
    },
  };
}
