/**
 * Scoped Styles Sub-module
 * Team-scoped style library CRUD (includes public styles in listing).
 */

import type { Database } from '@/lib/db/client';
import type { NewStyle, Style } from '@/lib/db/schema';
import { styles } from '@/lib/db/schema';
import { and, asc, desc, eq, or, sql } from 'drizzle-orm';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'db', 'styles']);

type StylesListOptions = {
  orderBy?: 'popular' | 'sortOrder';
};

function createStylesReadMethods(db: Database, teamId: string) {
  return {
    list: async (options: StylesListOptions = {}): Promise<Style[]> => {
      const orderBy = options.orderBy ?? 'sortOrder';
      const order =
        orderBy === 'popular'
          ? [desc(styles.usageCount), asc(styles.name)]
          : [asc(styles.sortOrder), asc(styles.name)];
      return await db
        .select()
        .from(styles)
        .where(or(eq(styles.teamId, teamId), eq(styles.isPublic, true)))
        .orderBy(...order);
    },

    getById: async (styleId: string): Promise<Style | null> => {
      const result = await db
        .select()
        .from(styles)
        .where(eq(styles.id, styleId))
        .limit(1);
      return result[0] ?? null;
    },
  };
}

/**
 * Public (anonymous) styles reads. Takes no team scope at all, so this code
 * path cannot express a team-scoped query — the isPublic filter is the entire
 * data boundary for the unauthenticated style-catalogue endpoint.
 */
export function createPublicStylesReadMethods(db: Database) {
  return {
    list: async (): Promise<Style[]> => {
      return await db
        .select()
        .from(styles)
        .where(eq(styles.isPublic, true))
        .orderBy(asc(styles.sortOrder), asc(styles.name));
    },
  };
}

export function createStylesMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  return {
    ...createStylesReadMethods(db, teamId),

    create: async (
      data: Omit<NewStyle, 'teamId' | 'createdBy'>
    ): Promise<Style> => {
      const result = await db
        .insert(styles)
        .values({ ...data, teamId, createdBy: userId })
        .returning();
      const style = result[0];
      if (!style) {
        throw new Error(`Failed to create Style for team ${teamId}`);
      }
      return style;
    },

    update: async (
      styleId: string,
      data: Partial<Omit<Style, 'id' | 'teamId' | 'createdAt' | 'createdBy'>>
    ): Promise<Style | undefined> => {
      const result = await db
        .update(styles)
        .set(data)
        .where(and(eq(styles.id, styleId), eq(styles.teamId, teamId)))
        .returning();
      return Array.isArray(result) ? result[0] : undefined;
    },

    delete: async (styleId: string): Promise<void> => {
      await db
        .delete(styles)
        .where(and(eq(styles.id, styleId), eq(styles.teamId, teamId)));
    },

    incrementUsage: async (styleId: string): Promise<void> => {
      const rows = await db
        .update(styles)
        .set({ usageCount: sql`${styles.usageCount} + 1` })
        .where(eq(styles.id, styleId))
        .returning({ id: styles.id });
      if (rows.length === 0) {
        logger.warn('incrementUsage matched zero rows', { styleId });
      }
    },
  };
}
