/**
 * Scoped Sequence Locations Sub-module
 * Location CRUD, reference images, and frame-location matching.
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import type {
  Frame,
  NewSequenceLocation,
  ReferenceStatus,
  SequenceLocation,
} from '@/lib/db/schema';
import { frames, sequenceLocations, sequences } from '@/lib/db/schema';

// ============================================================================
// Pure utility functions (exported separately, not in factory)
// ============================================================================

/**
 * Match a location to a scene's environmentTag
 */
export function locationMatchesTag(
  location: SequenceLocation,
  environmentTag: string
): boolean {
  if (!environmentTag) return false;

  const consistencyTag = (location.consistencyTag ?? '').toLowerCase();
  const locName = location.name.toLowerCase();
  const locId = location.locationId.toLowerCase();
  const envTagLower = environmentTag.toLowerCase();

  // Check if any of the location identifiers match the environment tag
  if (consistencyTag && envTagLower.includes(consistencyTag)) return true;
  if (envTagLower.includes(locName)) return true;
  if (envTagLower.includes(locId)) return true;

  // Also check if location name contains the env tag (reverse match)
  if (locName.includes(envTagLower)) return true;

  return false;
}

/**
 * Match locations to a frame based on metadata
 * Used when generating frame images to include location references
 */
export function matchLocationsToFrame(
  frame: Pick<Frame, 'metadata'>,
  allLocations: SequenceLocation[]
): SequenceLocation[] {
  const environmentTag = frame.metadata?.continuity?.environmentTag ?? '';
  const sceneLocation = frame.metadata?.metadata?.location ?? '';

  if (!environmentTag && !sceneLocation) return [];

  return allLocations.filter((location) => {
    return (
      (environmentTag && locationMatchesTag(location, environmentTag)) ||
      (sceneLocation && locationMatchesTag(location, sceneLocation))
    );
  });
}

// ============================================================================
// Factory function
// ============================================================================

export function createSequenceLocationsMethods(db: Database) {
  // Private update helper
  const update = async (
    id: string,
    data: Partial<NewSequenceLocation>
  ): Promise<SequenceLocation> => {
    const [location] = await db
      .update(sequenceLocations)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(sequenceLocations.id, id))
      .returning();

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
    if (!location) {
      throw new Error(`SequenceLocation ${id} not found`);
    }

    return location;
  };

  return {
    getById: async (id: string): Promise<SequenceLocation | null> => {
      const result = await db
        .select()
        .from(sequenceLocations)
        .where(eq(sequenceLocations.id, id));
      return result[0] ?? null;
    },

    getByLocationId: async (
      sequenceId: string,
      locationId: string
    ): Promise<SequenceLocation | null> => {
      const result = await db
        .select()
        .from(sequenceLocations)
        .where(
          and(
            eq(sequenceLocations.sequenceId, sequenceId),
            eq(sequenceLocations.locationId, locationId)
          )
        );
      return result[0] ?? null;
    },

    list: async (sequenceId: string): Promise<SequenceLocation[]> => {
      return await db
        .select()
        .from(sequenceLocations)
        .where(eq(sequenceLocations.sequenceId, sequenceId));
    },

    listWithReferences: async (
      sequenceId: string
    ): Promise<SequenceLocation[]> => {
      return await db
        .select()
        .from(sequenceLocations)
        .where(
          and(
            eq(sequenceLocations.sequenceId, sequenceId),
            eq(sequenceLocations.referenceStatus, 'completed')
          )
        );
    },

    getByIds: async (ids: string[]): Promise<SequenceLocation[]> => {
      if (ids.length === 0) return [];
      return await db
        .select()
        .from(sequenceLocations)
        .where(inArray(sequenceLocations.id, ids));
    },

    create: async (data: NewSequenceLocation): Promise<SequenceLocation> => {
      const [location] = await db
        .insert(sequenceLocations)
        .values(data)
        .onConflictDoUpdate({
          target: [sequenceLocations.sequenceId, sequenceLocations.locationId],
          set: {
            name: data.name,
            libraryLocationId: data.libraryLocationId,
            type: data.type,
            timeOfDay: data.timeOfDay,
            description: data.description,
            architecturalStyle: data.architecturalStyle,
            keyFeatures: data.keyFeatures,
            colorPalette: data.colorPalette,
            lightingSetup: data.lightingSetup,
            ambiance: data.ambiance,
            consistencyTag: data.consistencyTag,
            referenceImageUrl: data.referenceImageUrl,
            referenceImagePath: data.referenceImagePath,
            referenceStatus: data.referenceStatus,
            referenceGeneratedAt: data.referenceGeneratedAt,
            updatedAt: new Date(),
          },
        })
        .returning();
      return location;
    },

    createBulk: async (
      data: NewSequenceLocation[]
    ): Promise<SequenceLocation[]> => {
      if (data.length === 0) return [];
      const BATCH_SIZE = 3;
      const results: SequenceLocation[] = [];

      for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const batch = data.slice(i, i + BATCH_SIZE);
        const batchResults = await db
          .insert(sequenceLocations)
          .values(batch)
          .returning();
        results.push(...batchResults);
      }

      return results;
    },

    update,

    delete: async (id: string): Promise<boolean> => {
      const result = await db
        .delete(sequenceLocations)
        .where(eq(sequenceLocations.id, id));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return (result.rowsAffected ?? 0) > 0;
    },

    deleteBySequence: async (sequenceId: string): Promise<number> => {
      const result = await db
        .delete(sequenceLocations)
        .where(eq(sequenceLocations.sequenceId, sequenceId));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
      return result.rowsAffected ?? 0;
    },

    updateReferenceStatus: async (
      id: string,
      status: ReferenceStatus,
      error?: string
    ): Promise<SequenceLocation> => {
      return await update(id, {
        referenceStatus: status,
        referenceError: error ?? null,
        ...(status === 'completed' && { referenceGeneratedAt: new Date() }),
      });
    },

    updateReference: async (
      id: string,
      imageUrl: string,
      imagePath: string,
      inputHash: string | null = null
    ): Promise<SequenceLocation> => {
      return await update(id, {
        referenceImageUrl: imageUrl,
        referenceImagePath: imagePath,
        referenceStatus: 'completed',
        referenceGeneratedAt: new Date(),
        referenceError: null,
        referenceInputHash: inputHash,
      });
    },

    /**
     * True iff `currentHash` differs from the stored `referenceInputHash`.
     * Returns false when no hash has been recorded yet (legacy artifact, no
     * opinion). Mirrors `characters.isStale` and `locationLibrary.isStale`.
     */
    isStale: async (
      locationId: string,
      currentHash: string
    ): Promise<boolean> => {
      const result = await db
        .select({ hash: sequenceLocations.referenceInputHash })
        .from(sequenceLocations)
        .where(eq(sequenceLocations.id, locationId));
      if (result.length === 0) {
        throw new Error(`SequenceLocation ${locationId} not found`);
      }
      const stored = result[0].hash;
      if (stored === null) return false;
      return currentHash !== stored;
    },

    getNeedingReferences: async (
      sequenceId: string
    ): Promise<SequenceLocation[]> => {
      return await db
        .select()
        .from(sequenceLocations)
        .where(
          and(
            eq(sequenceLocations.sequenceId, sequenceId),
            inArray(sequenceLocations.referenceStatus, ['pending', 'failed'])
          )
        );
    },

    getFramesForLocation: async (
      sequenceId: string,
      locationId: string
    ): Promise<Frame[]> => {
      // Get the location to extract matching patterns
      const locResult = await db
        .select()
        .from(sequenceLocations)
        .where(eq(sequenceLocations.id, locationId));
      const location = locResult[0] ?? null;
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
      if (!location || location.sequenceId !== sequenceId) {
        return [];
      }

      // Get all frames for the sequence
      const allFrames = await db
        .select()
        .from(frames)
        .where(eq(frames.sequenceId, sequenceId));

      // Filter frames that are at this location
      return (allFrames as Frame[]).filter((frame) => {
        const environmentTag = frame.metadata?.continuity?.environmentTag ?? '';
        const sceneLocation = frame.metadata?.metadata?.location ?? '';

        return (
          (environmentTag && locationMatchesTag(location, environmentTag)) ||
          (sceneLocation && locationMatchesTag(location, sceneLocation))
        );
      });
    },

    getFrameIdsForLocation: async (
      sequenceId: string,
      locationId: string
    ): Promise<string[]> => {
      // Get the location to extract matching patterns
      const locResult = await db
        .select()
        .from(sequenceLocations)
        .where(eq(sequenceLocations.id, locationId));
      const location = locResult[0] ?? null;
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
      if (!location || location.sequenceId !== sequenceId) {
        return [];
      }

      // Get all frames for the sequence
      const allFrames = await db
        .select()
        .from(frames)
        .where(eq(frames.sequenceId, sequenceId));

      // Filter frames and return IDs
      return (allFrames as Frame[])
        .filter((frame) => {
          const environmentTag =
            frame.metadata?.continuity?.environmentTag ?? '';
          const sceneLocation = frame.metadata?.metadata?.location ?? '';

          return (
            (environmentTag && locationMatchesTag(location, environmentTag)) ||
            (sceneLocation && locationMatchesTag(location, sceneLocation))
          );
        })
        .map((f) => f.id);
    },

    getTeamLibrary: async (
      teamId: string,
      options?: {
        excludeSequenceId?: string;
        limit?: number;
        /** If true, only return locations with completed reference images */
        completedOnly?: boolean;
      }
    ): Promise<(SequenceLocation & { sequenceTitle: string })[]> => {
      const result = await db
        .select({
          location: sequenceLocations,
          sequenceTitle: sequences.title,
        })
        .from(sequenceLocations)
        .innerJoin(sequences, eq(sequenceLocations.sequenceId, sequences.id))
        .where(
          and(
            eq(sequences.teamId, teamId),
            options?.completedOnly
              ? eq(sequenceLocations.referenceStatus, 'completed')
              : undefined,
            options?.excludeSequenceId
              ? // Optionally exclude current sequence
                // to avoid showing duplicate locations
                undefined
              : undefined
          )
        )
        .limit(options?.limit ?? 100);

      return result.map((r) => ({
        ...r.location,
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
        sequenceTitle: r.sequenceTitle ?? 'Untitled',
      }));
    },
  };
}
