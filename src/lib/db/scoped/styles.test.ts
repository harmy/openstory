/**
 * Scoped styles tests:
 *   - incrementUsage atomically bumps usageCount.
 *   - list({ orderBy: 'popular' }) sorts by usageCount desc.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  spyOn,
} from 'bun:test';
import { type Client, createClient } from '@libsql/client';
import { asc, desc, eq, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/lib/db/id';
import type { Database } from '@/lib/db/client';
import {
  styles,
  teams,
  user,
  type NewStyle,
  type Style,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';

// scoped.test.ts registers a global module mock for @/lib/db/scoped/styles
// via bun:test mock.module(), and bun does not reliably unwind module mocks
// (https://github.com/oven-sh/bun/issues/7823) — so importing the real
// createStylesMethods here would yield stubs in a full-suite run. We mirror
// the production methods inline against an in-memory libSQL DB to exercise
// real SQL behavior; keep these in lockstep with src/lib/db/scoped/styles.ts.
function makeStylesMethods(database: Database, teamId: string, userId: string) {
  return {
    list: async (
      options: { orderBy?: 'popular' | 'sortOrder' } = {}
    ): Promise<Style[]> => {
      const orderBy = options.orderBy ?? 'sortOrder';
      const order =
        orderBy === 'popular'
          ? [desc(styles.usageCount), asc(styles.name)]
          : [asc(styles.sortOrder), asc(styles.name)];
      return await database
        .select()
        .from(styles)
        .where(or(eq(styles.teamId, teamId), eq(styles.isPublic, true)))
        .orderBy(...order);
    },
    getById: async (styleId: string): Promise<Style | null> => {
      const result = await database
        .select()
        .from(styles)
        .where(eq(styles.id, styleId))
        .limit(1);
      return result[0] ?? null;
    },
    create: async (
      data: Omit<NewStyle, 'teamId' | 'createdBy'>
    ): Promise<Style> => {
      const result = await database
        .insert(styles)
        .values({ ...data, teamId, createdBy: userId })
        .returning();
      const style = result[0];
      if (!style) throw new Error('insert returned nothing');
      return style;
    },
    incrementUsage: async (styleId: string): Promise<void> => {
      const rows = await database
        .update(styles)
        .set({ usageCount: sql`${styles.usageCount} + 1` })
        .where(eq(styles.id, styleId))
        .returning({ id: styles.id });
      if (rows.length === 0) {
        console.warn('[styles] incrementUsage matched zero rows', { styleId });
      }
    },
  };
}

let client: Client;
let db: Database;

const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };

const baseConfig = {
  mood: 'neutral',
  artStyle: 'cinematic',
  lighting: 'natural',
  colorPalette: ['#000', '#fff'],
  cameraWork: 'static',
  referenceFilms: [],
  colorGrading: 'neutral',
};

async function seed() {
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  team.id = generateId();
  userRow.id = generateId();

  await db.insert(user).values([userRow]);
  await db.insert(teams).values([team]);
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('createStylesMethods.incrementUsage', () => {
  it('bumps usageCount by 1 on each call', async () => {
    const methods = makeStylesMethods(db, team.id, userRow.id);

    const style = await methods.create({
      name: 'Bumped',
      config: baseConfig,
      sortOrder: 1,
    });
    expect(style.usageCount).toBe(0);

    await methods.incrementUsage(style.id);
    await methods.incrementUsage(style.id);

    const after = await methods.getById(style.id);
    expect(after?.usageCount).toBe(2);
  });

  it('logs a warning when the styleId matches zero rows', async () => {
    const methods = makeStylesMethods(db, team.id, userRow.id);
    const warn = spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await methods.incrementUsage('does_not_exist');
      expect(warn).toHaveBeenCalledWith(
        '[styles] incrementUsage matched zero rows',
        { styleId: 'does_not_exist' }
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe("createStylesMethods.list({ orderBy: 'popular' })", () => {
  it('orders by usageCount desc when popular requested', async () => {
    const methods = makeStylesMethods(db, team.id, userRow.id);

    const a = await methods.create({
      name: 'A-cold',
      config: baseConfig,
      sortOrder: 1,
    });
    const b = await methods.create({
      name: 'B-hot',
      config: baseConfig,
      sortOrder: 2,
    });
    const c = await methods.create({
      name: 'C-warm',
      config: baseConfig,
      sortOrder: 3,
    });

    await methods.incrementUsage(b.id);
    await methods.incrementUsage(b.id);
    await methods.incrementUsage(b.id);
    await methods.incrementUsage(c.id);

    const popular = await methods.list({ orderBy: 'popular' });
    expect(popular.map((s) => s.id)).toEqual([b.id, c.id, a.id]);

    const sorted = await methods.list();
    expect(sorted.map((s) => s.id)).toEqual([a.id, b.id, c.id]);
  });

  it('includes public styles owned by other teams', async () => {
    const otherTeamId = generateId();
    await db
      .insert(teams)
      .values([{ id: otherTeamId, name: 'Other', slug: 'o' }]);

    const ownMethods = makeStylesMethods(db, team.id, userRow.id);
    const otherMethods = makeStylesMethods(db, otherTeamId, userRow.id);

    const mine = await ownMethods.create({
      name: 'Mine',
      config: baseConfig,
      sortOrder: 1,
    });
    const theirsPublic = await otherMethods.create({
      name: 'TheirsPublic',
      config: baseConfig,
      sortOrder: 2,
      isPublic: true,
    });
    const theirsPrivate = await otherMethods.create({
      name: 'TheirsPrivate',
      config: baseConfig,
      sortOrder: 3,
    });

    const visible = await ownMethods.list();
    const ids = visible.map((s) => s.id);
    expect(ids).toContain(mine.id);
    expect(ids).toContain(theirsPublic.id);
    expect(ids).not.toContain(theirsPrivate.id);
  });
});

describe('createStylesMethods.create — new schema fields round-trip', () => {
  it('persists sampleVideos, useCases, recommended* and defaultAspectRatio', async () => {
    const methods = makeStylesMethods(db, team.id, userRow.id);

    const created = await methods.create({
      name: 'Loaded',
      config: baseConfig,
      sortOrder: 1,
      sampleVideos: [
        {
          url: 'https://example.com/v.mp4',
          kind: 'canonical',
          label: 'demo',
          durationSeconds: 5,
          order: 0,
        },
      ],
      useCases: ['promo', 'social'],
      recommendedImageModel: 'flux_pro',
      recommendedVideoModel: 'wan_i2v',
      defaultAspectRatio: '16:9',
    });

    const fetched = await methods.getById(created.id);
    expect(fetched?.sampleVideos).toEqual([
      {
        url: 'https://example.com/v.mp4',
        kind: 'canonical',
        label: 'demo',
        durationSeconds: 5,
        order: 0,
      },
    ]);
    expect(fetched?.useCases).toEqual(['promo', 'social']);
    expect(fetched?.recommendedImageModel).toBe('flux_pro');
    expect(fetched?.recommendedVideoModel).toBe('wan_i2v');
    expect(fetched?.defaultAspectRatio).toBe('16:9');
  });
});
