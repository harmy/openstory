/**
 * Scoped Frames Sub-module
 * Frame CRUD, bulk operations, reorder, and reconciliation.
 */

import type { Database } from '@/lib/db/client';
import { frames } from '@/lib/db/schema';
import type { Frame, NewFrame } from '@/lib/db/schema';
import type { Sequence } from '@/lib/db/schema/sequences';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

type FrameWithSequence = Frame & {
  sequence: Pick<
    Sequence,
    | 'id'
    | 'teamId'
    | 'title'
    | 'status'
    | 'styleId'
    | 'videoModel'
    | 'aspectRatio'
  >;
};

type FrameOrderBy = 'orderIndex' | 'createdAt' | 'updatedAt';

type FrameFilters = {
  orderBy?: FrameOrderBy;
  ascending?: boolean;
  limit?: number;
  offset?: number;
  hasThumbnail?: boolean;
  hasVideo?: boolean;
};

export function createFramesMethods(db: Database) {
  return {
    getById: async (frameId: string): Promise<Frame | null> => {
      const result = await db
        .select()
        .from(frames)
        .where(eq(frames.id, frameId));
      return result[0] ?? null;
    },

    listBySequence: async (
      sequenceId: string,
      options?: FrameFilters
    ): Promise<Frame[]> => {
      const {
        orderBy = 'orderIndex',
        ascending = true,
        limit,
        offset,
        hasThumbnail,
        hasVideo,
      } = options ?? {};

      const conditions = [eq(frames.sequenceId, sequenceId)];

      if (hasThumbnail !== undefined && hasThumbnail) {
        conditions.push(isNull(frames.thumbnailUrl));
      }

      if (hasVideo !== undefined && hasVideo) {
        conditions.push(isNull(frames.videoUrl));
      }

      const orderColumn =
        orderBy === 'orderIndex'
          ? frames.orderIndex
          : orderBy === 'createdAt'
            ? frames.createdAt
            : frames.updatedAt;

      const orderFn = ascending ? asc : desc;

      let query = db
        .select()
        .from(frames)
        .where(and(...conditions))
        .orderBy(orderFn(orderColumn))
        .$dynamic();

      if (limit) {
        query = query.limit(limit);
      }

      if (offset) {
        query = query.offset(offset);
      }

      return await query;
    },

    create: async (data: NewFrame): Promise<Frame> => {
      const [frame] = await db.insert(frames).values(data).returning();
      return frame;
    },

    update: async (
      frameId: string,
      data: Partial<NewFrame>,
      options?: { throwOnMissing?: boolean }
    ): Promise<Frame | undefined> => {
      const [frame] = await db
        .update(frames)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(frames.id, frameId))
        .returning();

      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
      if (!frame && options?.throwOnMissing !== false) {
        throw new Error(`Frame ${frameId} not found`);
      }

      return frame;
    },
    /**
     * Upsert a single frame using conflict resolution on (sequenceId, orderIndex).
     * Idempotent: safe to call on retry without creating duplicates.
     */
    upsert: async (data: NewFrame): Promise<Frame> => {
      const [frame] = await db
        .insert(frames)
        .values(data)
        .onConflictDoUpdate({
          target: [frames.sequenceId, frames.orderIndex],
          set: {
            description: sql.raw(`excluded."description"`),
            durationMs: sql.raw(`excluded."duration_ms"`),
            metadata: sql.raw(`excluded."metadata"`),
            updatedAt: new Date(),
          },
        })
        .returning();
      return frame;
    },
    delete: async (frameId: string): Promise<boolean> => {
      const result = await db.delete(frames).where(eq(frames.id, frameId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(frames)
        .where(eq(frames.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    createBulk: async (frameData: NewFrame[]): Promise<Frame[]> => {
      const BATCH_SIZE = 5;
      const results: Frame[] = [];

      for (let i = 0; i < frameData.length; i += BATCH_SIZE) {
        const batch = frameData.slice(i, i + BATCH_SIZE);
        const batchResults = await db.insert(frames).values(batch).returning();
        results.push(...batchResults);
      }

      return results;
    },

    bulkUpsert: async (frameInserts: NewFrame[]): Promise<Frame[]> => {
      const BATCH_SIZE = 5;
      const results: Frame[] = [];

      for (let i = 0; i < frameInserts.length; i += BATCH_SIZE) {
        const batch = frameInserts.slice(i, i + BATCH_SIZE);
        const batchResults = await db
          .insert(frames)
          .values(batch)
          .onConflictDoUpdate({
            target: [frames.sequenceId, frames.orderIndex],
            set: {
              description: sql.raw(`excluded."description"`),
              durationMs: sql.raw(`excluded."duration_ms"`),
              metadata: sql.raw(`excluded."metadata"`),
              updatedAt: new Date(),
            },
          })
          .returning();
        results.push(...batchResults);
      }

      return results;
    },

    reorder: async (
      _sequenceId: string,
      frameOrders: Array<{ id: string; order_index: number }>
    ): Promise<void> => {
      if (frameOrders.length === 0) return;
      const [first, ...rest] = frameOrders.map((frameOrder) =>
        db
          .update(frames)
          .set({ orderIndex: frameOrder.order_index, updatedAt: new Date() })
          .where(eq(frames.id, frameOrder.id))
      );
      await db.batch([first, ...rest]);
    },

    getByIds: async (frameIds: string[]): Promise<Frame[]> => {
      if (frameIds.length === 0) return [];
      return await db.select().from(frames).where(inArray(frames.id, frameIds));
    },

    getWithSequence: async (
      frameId: string
    ): Promise<FrameWithSequence | null> => {
      const result = await db.query.frames.findFirst({
        where: { id: frameId },
        with: {
          sequence: {
            columns: {
              id: true,
              teamId: true,
              title: true,
              status: true,
              styleId: true,
              videoModel: true,
              aspectRatio: true,
            },
          },
        },
      });

      if (!result || !result.sequence) return null;
      return { ...result, sequence: result.sequence };
    },
  };
}
