/**
 * Scoped sequence_exports CRUD. Exports are flat — no primary/divergent
 * split — and rows accumulate. The newest row per sequence is what the UI
 * surfaces as "your latest download".
 *
 * Two producers write here:
 * - the browser export pipeline (see `src/lib/sequence-player/export.ts`),
 *   which commits a finished `ready` row directly; and
 * - the server-side (API) export workflow, which `createProcessing()`s a row
 *   up front and later flips it to `ready`/`failed`.
 *
 * `listBySequence`/`getLatest` are `ready`-only so the download UI never offers
 * an in-flight or failed server export; the API uses `listAllBySequence` to
 * surface progress.
 */

import type { Database } from '@/lib/db/client';
import {
  sequenceExports,
  type NewSequenceExport,
  type SequenceExport,
} from '@/lib/db/schema';
import { and, desc, eq } from 'drizzle-orm';

export function createSequenceExportsMethods(db: Database) {
  return {
    /** Newest-first list of every *ready* export for `sequenceId` (UI). */
    listBySequence: async (sequenceId: string): Promise<SequenceExport[]> => {
      return await db
        .select()
        .from(sequenceExports)
        .where(
          and(
            eq(sequenceExports.sequenceId, sequenceId),
            eq(sequenceExports.status, 'ready')
          )
        )
        .orderBy(desc(sequenceExports.createdAt));
    },

    /** Newest-first list of exports in any status (API — includes progress). */
    listAllBySequence: async (
      sequenceId: string
    ): Promise<SequenceExport[]> => {
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
        .where(
          and(
            eq(sequenceExports.sequenceId, sequenceId),
            eq(sequenceExports.status, 'ready')
          )
        )
        .orderBy(desc(sequenceExports.createdAt))
        .limit(1);
      return rows[0] ?? null;
    },

    getById: async (id: string): Promise<SequenceExport | null> => {
      const rows = await db
        .select()
        .from(sequenceExports)
        .where(eq(sequenceExports.id, id))
        .limit(1);
      return rows[0] ?? null;
    },

    insert: async (input: NewSequenceExport): Promise<SequenceExport> => {
      const [row] = await db.insert(sequenceExports).values(input).returning();
      if (!row) throw new Error('Failed to insert sequence export');
      return row;
    },

    /** Reserve a `processing` row for a server-side export run. */
    createProcessing: async (input: {
      sequenceId: string;
      url: string;
      storagePath: string;
      workflowRunId?: string | null;
    }): Promise<SequenceExport> => {
      const [row] = await db
        .insert(sequenceExports)
        .values({ ...input, status: 'processing' })
        .returning();
      if (!row) throw new Error('Failed to create sequence export');
      return row;
    },

    markReady: async (
      id: string,
      fields: { durationSeconds?: number | null }
    ): Promise<void> => {
      await db
        .update(sequenceExports)
        .set({
          status: 'ready',
          error: null,
          durationSeconds: fields.durationSeconds ?? null,
        })
        .where(eq(sequenceExports.id, id));
    },

    markFailed: async (id: string, error: string): Promise<void> => {
      await db
        .update(sequenceExports)
        .set({ status: 'failed', error })
        .where(eq(sequenceExports.id, id));
    },

    setWorkflowRunId: async (
      id: string,
      workflowRunId: string
    ): Promise<void> => {
      await db
        .update(sequenceExports)
        .set({ workflowRunId })
        .where(eq(sequenceExports.id, id));
    },
  };
}
