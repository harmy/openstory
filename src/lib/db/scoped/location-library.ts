/**
 * Scoped Location Library Sub-module
 * Team-scoped location library CRUD and location sheet operations.
 */

import { eq, ilike, and, inArray, or } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import { locationLibrary, locationSheets } from '@/lib/db/schema';
import type {
  LibraryLocation,
  NewLibraryLocation,
  NewLocationSheet,
} from '@/lib/db/schema';

export function createLocationsReadMethods(db: Database, teamId: string) {
  return {
    list: async (): Promise<LibraryLocation[]> => {
      return await db
        .select()
        .from(locationLibrary)
        .where(
          or(
            eq(locationLibrary.teamId, teamId),
            eq(locationLibrary.isPublic, true)
          )
        );
    },

    search: async (query: string, limit = 10): Promise<LibraryLocation[]> => {
      return await db
        .select()
        .from(locationLibrary)
        .where(
          and(
            or(
              eq(locationLibrary.teamId, teamId),
              eq(locationLibrary.isPublic, true)
            ),
            ilike(locationLibrary.name, `%${query}%`)
          )
        )
        .limit(limit);
    },

    withReferences: async (): Promise<LibraryLocation[]> => {
      const locations = await db
        .select()
        .from(locationLibrary)
        .where(
          or(
            eq(locationLibrary.teamId, teamId),
            eq(locationLibrary.isPublic, true)
          )
        );
      return locations.filter((loc) => loc.referenceImageUrl !== null);
    },

    getById: async (id: string): Promise<LibraryLocation | null> => {
      const result = await db
        .select()
        .from(locationLibrary)
        .where(
          and(
            eq(locationLibrary.id, id),
            or(
              eq(locationLibrary.teamId, teamId),
              eq(locationLibrary.isPublic, true)
            )
          )
        );
      return result[0] ?? null;
    },

    getByIds: async (ids: string[]): Promise<LibraryLocation[]> => {
      if (ids.length === 0) return [];
      return await db
        .select()
        .from(locationLibrary)
        .where(inArray(locationLibrary.id, ids));
    },
  };
}

export function createLocationsMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  return {
    ...createLocationsReadMethods(db, teamId),

    create: async (
      data: Omit<NewLibraryLocation, 'teamId' | 'createdBy'>
    ): Promise<LibraryLocation> => {
      const [location] = await db
        .insert(locationLibrary)
        .values({ ...data, teamId, createdBy: userId })
        .returning();
      return location;
    },

    createBulk: async (
      data: Omit<NewLibraryLocation, 'teamId' | 'createdBy'>[]
    ): Promise<LibraryLocation[]> => {
      if (data.length === 0) return [];
      const BATCH_SIZE = 10;
      const results: LibraryLocation[] = [];

      for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const batch = data.slice(i, i + BATCH_SIZE);
        const batchResults = await db
          .insert(locationLibrary)
          .values(batch.map((d) => ({ ...d, teamId, createdBy: userId })))
          .returning();
        results.push(...batchResults);
      }

      return results;
    },

    delete: async (id: string): Promise<boolean> => {
      const result = await db
        .delete(locationLibrary)
        .where(eq(locationLibrary.id, id));
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteAll: async (): Promise<number> => {
      const result = await db
        .delete(locationLibrary)
        .where(eq(locationLibrary.teamId, teamId));
      return result.rowsAffected ?? 0;
    },

    update: async (
      id: string,
      data: Partial<NewLibraryLocation>
    ): Promise<LibraryLocation> => {
      const [location] = await db
        .update(locationLibrary)
        .set({ ...data, updatedAt: new Date() })
        .where(eq(locationLibrary.id, id))
        .returning();

      if (!location) {
        throw new Error(`LibraryLocation ${id} not found`);
      }

      return location;
    },

    updateReference: async (
      id: string,
      referenceImageUrl: string,
      referenceImagePath: string
    ): Promise<LibraryLocation> => {
      const [location] = await db
        .update(locationLibrary)
        .set({ referenceImageUrl, referenceImagePath, updatedAt: new Date() })
        .where(eq(locationLibrary.id, id))
        .returning();

      if (!location) {
        throw new Error(`LibraryLocation ${id} not found`);
      }

      return location;
    },
  };
}

export function createLocationSheetsReadMethods(db: Database) {
  return {
    list: async (locationId: string) => {
      return db
        .select()
        .from(locationSheets)
        .where(eq(locationSheets.locationId, locationId));
    },

    getWithLocation: async (sheetId: string) => {
      const result = await db
        .select({ sheet: locationSheets, location: locationLibrary })
        .from(locationSheets)
        .innerJoin(
          locationLibrary,
          eq(locationSheets.locationId, locationLibrary.id)
        )
        .where(eq(locationSheets.id, sheetId));
      return result[0] ?? null;
    },
  };
}

export function createLocationSheetsMethods(db: Database) {
  return {
    ...createLocationSheetsReadMethods(db),

    insert: async (sheets: NewLocationSheet[]) => {
      if (sheets.length === 0) return [];
      return db.insert(locationSheets).values(sheets).returning();
    },

    delete: async (sheetId: string) => {
      await db.delete(locationSheets).where(eq(locationSheets.id, sheetId));
    },

    promoteDefault: async (locationId: string) => {
      const [nextSheet] = await db
        .select()
        .from(locationSheets)
        .where(eq(locationSheets.locationId, locationId))
        .limit(1);

      if (nextSheet) {
        await db
          .update(locationSheets)
          .set({ isDefault: true })
          .where(eq(locationSheets.id, nextSheet.id));

        if (nextSheet.imageUrl) {
          await db
            .update(locationLibrary)
            .set({
              referenceImageUrl: nextSheet.imageUrl,
              referenceImagePath: nextSheet.imagePath,
              updatedAt: new Date(),
            })
            .where(eq(locationLibrary.id, locationId));
        }
      } else {
        await db
          .update(locationLibrary)
          .set({
            referenceImageUrl: null,
            referenceImagePath: null,
            updatedAt: new Date(),
          })
          .where(eq(locationLibrary.id, locationId));
      }
    },
  };
}
