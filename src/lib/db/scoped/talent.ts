/**
 * Scoped Talent Sub-module
 * Team-scoped talent library CRUD with sheet counts and default sheets.
 */

import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import { talent, talentMedia, talentSheets } from '@/lib/db/schema';
import type {
  NewTalent,
  NewTalentMedia,
  NewTalentSheet,
  Talent,
  TalentMediaRecord,
  TalentSheet,
  TalentWithSheets,
} from '@/lib/db/schema';

function createTalentReadMethods(db: Database, teamId: string) {
  return {
    list: async (options?: {
      favoritesOnly?: boolean;
    }): Promise<TalentWithSheets[]> => {
      const conditions = [eq(talent.teamId, teamId)];
      if (options?.favoritesOnly) {
        conditions.push(eq(talent.isFavorite, true));
      }

      const results = await db
        .select({
          talent: talent,
          sheetCount: sql<number>`(
            SELECT COUNT(*) FROM talent_sheets
            WHERE talent_sheets.talent_id = ${sql.raw(`"talent"."id"`)}
          )`
            .mapWith(Number)
            .as('sheet_count'),
        })
        .from(talent)
        .where(and(...conditions))
        .orderBy(desc(talent.isFavorite), asc(talent.name));

      const talentIds = results.map((r) => r.talent.id);
      if (talentIds.length === 0) return [];

      const defaultSheets = await db
        .select()
        .from(talentSheets)
        .where(
          and(
            sql`${talentSheets.talentId} IN (${sql.join(
              talentIds.map((id) => sql`${id}`),
              sql`, `
            )})`,
            eq(talentSheets.isDefault, true)
          )
        );

      const sheetMap = new Map<string, TalentSheet>(
        defaultSheets.map((s) => [s.talentId, s])
      );

      const talentWithoutDefault = talentIds.filter((id) => !sheetMap.has(id));
      if (talentWithoutDefault.length > 0) {
        const fallbackSheets = await db
          .select()
          .from(talentSheets)
          .where(
            sql`${talentSheets.talentId} IN (${sql.join(
              talentWithoutDefault.map((id) => sql`${id}`),
              sql`, `
            )})`
          )
          .orderBy(desc(talentSheets.createdAt));

        for (const sheet of fallbackSheets) {
          if (!sheetMap.has(sheet.talentId)) {
            sheetMap.set(sheet.talentId, sheet);
          }
        }
      }

      return results.map((r) => ({
        ...r.talent,
        sheetCount: r.sheetCount,
        sheets: [],
        defaultSheet: sheetMap.get(r.talent.id) ?? null,
      }));
    },

    getByIds: async (ids: string[]): Promise<TalentWithSheets[]> => {
      if (ids.length === 0) return [];

      const results = await db
        .select({
          talent: talent,
          sheetCount: sql<number>`(
            SELECT COUNT(*) FROM talent_sheets
            WHERE talent_sheets.talent_id = ${sql.raw(`"talent"."id"`)}
          )`
            .mapWith(Number)
            .as('sheet_count'),
        })
        .from(talent)
        .where(
          and(
            eq(talent.teamId, teamId),
            sql`${talent.id} IN (${sql.join(
              ids.map((id) => sql`${id}`),
              sql`, `
            )})`
          )
        );

      if (results.length === 0) return [];

      const fetchedIds = results.map((r) => r.talent.id);
      const defaultSheets = await db
        .select()
        .from(talentSheets)
        .where(
          and(
            sql`${talentSheets.talentId} IN (${sql.join(
              fetchedIds.map((id) => sql`${id}`),
              sql`, `
            )})`,
            eq(talentSheets.isDefault, true)
          )
        );

      const sheetMap = new Map<string, TalentSheet>(
        defaultSheets.map((s) => [s.talentId, s])
      );

      const talentWithoutDefault = fetchedIds.filter((id) => !sheetMap.has(id));
      if (talentWithoutDefault.length > 0) {
        const fallbackSheets = await db
          .select()
          .from(talentSheets)
          .where(
            sql`${talentSheets.talentId} IN (${sql.join(
              talentWithoutDefault.map((id) => sql`${id}`),
              sql`, `
            )})`
          )
          .orderBy(desc(talentSheets.createdAt));

        for (const sheet of fallbackSheets) {
          if (!sheetMap.has(sheet.talentId)) {
            sheetMap.set(sheet.talentId, sheet);
          }
        }
      }

      return results.map((r) => ({
        ...r.talent,
        sheetCount: r.sheetCount,
        sheets: [],
        defaultSheet: sheetMap.get(r.talent.id) ?? null,
      }));
    },

    getById: async (talentId: string): Promise<Talent | undefined> => {
      return db.query.talent.findFirst({
        where: and(eq(talent.id, talentId), eq(talent.teamId, teamId)),
      });
    },

    getWithRelations: async (talentId: string) => {
      return db.query.talent.findFirst({
        where: and(eq(talent.id, talentId), eq(talent.teamId, teamId)),
        with: {
          sheets: {
            orderBy: [
              desc(talentSheets.isDefault),
              desc(talentSheets.createdAt),
            ],
          },
          media: {
            orderBy: [desc(talentMedia.createdAt)],
          },
        },
      });
    },

    sheets: {
      getById: async (sheetId: string): Promise<TalentSheet | undefined> => {
        return db.query.talentSheets.findFirst({
          where: eq(talentSheets.id, sheetId),
        });
      },
    },

    media: {
      getById: async (
        mediaId: string
      ): Promise<TalentMediaRecord | undefined> => {
        return db.query.talentMedia.findFirst({
          where: eq(talentMedia.id, mediaId),
        });
      },
    },
  };
}

export { createTalentReadMethods };

export function createTalentMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  const read = createTalentReadMethods(db, teamId);

  return {
    ...read,

    create: async (
      data: Omit<NewTalent, 'teamId' | 'createdBy'>
    ): Promise<Talent> => {
      const [created] = await db
        .insert(talent)
        .values({ ...data, teamId, createdBy: userId })
        .returning();
      return created;
    },

    update: async (
      talentId: string,
      data: Partial<Omit<Talent, 'id' | 'teamId' | 'createdAt' | 'createdBy'>>
    ): Promise<Talent | undefined> => {
      const [updated] = await db
        .update(talent)
        .set({ ...data, updatedAt: new Date() })
        .where(and(eq(talent.id, talentId), eq(talent.teamId, teamId)))
        .returning();
      return updated;
    },

    delete: async (talentId: string): Promise<boolean> => {
      const result = await db
        .delete(talent)
        .where(and(eq(talent.id, talentId), eq(talent.teamId, teamId)));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    toggleFavorite: async (talentId: string): Promise<Talent | undefined> => {
      const existing = await db.query.talent.findFirst({
        where: eq(talent.id, talentId),
      });
      if (!existing || existing.teamId !== teamId) return undefined;

      const [updated] = await db
        .update(talent)
        .set({ isFavorite: !existing.isFavorite, updatedAt: new Date() })
        .where(and(eq(talent.id, talentId), eq(talent.teamId, teamId)))
        .returning();
      return updated;
    },

    sheets: {
      ...read.sheets,

      create: async (data: NewTalentSheet): Promise<TalentSheet> => {
        const existingSheets = await db
          .select({ count: sql<number>`count(*)`.mapWith(Number) })
          .from(talentSheets)
          .where(eq(talentSheets.talentId, data.talentId));

        const sheetCount = existingSheets[0]?.count ?? 0;
        const shouldBeDefault = sheetCount === 0 || data.isDefault === true;

        if (shouldBeDefault && sheetCount > 0) {
          await db
            .update(talentSheets)
            .set({ isDefault: false })
            .where(eq(talentSheets.talentId, data.talentId));
        }

        const [sheet] = await db
          .insert(talentSheets)
          .values({ ...data, isDefault: shouldBeDefault })
          .returning();
        return sheet;
      },

      update: async (
        sheetId: string,
        data: Partial<Omit<TalentSheet, 'id' | 'talentId' | 'createdAt'>>
      ): Promise<TalentSheet | undefined> => {
        if (data.isDefault) {
          const sheet = await db.query.talentSheets.findFirst({
            where: eq(talentSheets.id, sheetId),
          });
          if (sheet) {
            await db
              .update(talentSheets)
              .set({ isDefault: false })
              .where(eq(talentSheets.talentId, sheet.talentId));
          }
        }

        const [updated] = await db
          .update(talentSheets)
          .set({ ...data, updatedAt: new Date() })
          .where(eq(talentSheets.id, sheetId))
          .returning();

        return updated;
      },

      delete: async (sheetId: string): Promise<boolean> => {
        const sheet = await db.query.talentSheets.findFirst({
          where: eq(talentSheets.id, sheetId),
        });
        if (!sheet) return false;

        const result = await db
          .delete(talentSheets)
          .where(eq(talentSheets.id, sheetId));

        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
        if ((result.rowsAffected ?? 0) === 0) return false;

        if (sheet.isDefault) {
          const remaining = await db
            .select()
            .from(talentSheets)
            .where(eq(talentSheets.talentId, sheet.talentId));

          if (remaining.length === 1) {
            await db
              .update(talentSheets)
              .set({ isDefault: true, updatedAt: new Date() })
              .where(eq(talentSheets.id, remaining[0].id));
          }
        }

        return true;
      },
    },

    media: {
      ...read.media,

      create: async (data: NewTalentMedia): Promise<TalentMediaRecord> => {
        const [media] = await db.insert(talentMedia).values(data).returning();
        return media;
      },

      delete: async (mediaId: string): Promise<boolean> => {
        const result = await db
          .delete(talentMedia)
          .where(eq(talentMedia.id, mediaId));
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
        return (result.rowsAffected ?? 0) > 0;
      },
    },
  };
}
