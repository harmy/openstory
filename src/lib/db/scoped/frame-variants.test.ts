/**
 * Schema-level acceptance tests for the partial-index split on `frame_variants`.
 *
 * The schema lays down two unique indexes keyed on `divergedAt IS NULL` vs.
 * `divergedAt IS NOT NULL`, so:
 *   - At most one primary row may exist per (frame, type, model).
 *   - Multiple divergent alternates may coexist as long as they have distinct
 *     `inputHash` values.
 * Plus the scoped wrappers (`getByFrameAndModel`, `insertDivergent`) must
 * respect that split: the getter returns the primary, the inserter is
 * idempotent on retry.
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { type Client, createClient } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/lib/db/id';
import {
  frameVariants,
  frames,
  sequences,
  styles,
  teams,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import type { Database } from '@/lib/db/client';
import { createFrameVariantsMethods } from './frame-variants';

type TestDb = LibSQLDatabase<Record<string, never>, typeof relations>;

const asDatabase = (testDb: TestDb): Database => testDb as unknown as Database;

let client: Client;
let db: TestDb;

const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };
let sequenceId = '';
let frameId = '';

async function seed() {
  await db.delete(frameVariants);
  await db.delete(frames);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  team.id = generateId();
  userRow.id = generateId();
  sequenceId = generateId();

  await db.insert(user).values([userRow]);
  await db.insert(teams).values([team]);
  const [style] = await db
    .insert(styles)
    .values({
      teamId: team.id,
      name: 'default',
      config: {
        mood: 'neutral',
        artStyle: 'cinematic',
        lighting: 'natural',
        colorPalette: ['#000', '#fff'],
        cameraWork: 'static',
        referenceFilms: [],
        colorGrading: 'neutral',
      },
    })
    .returning();
  await db
    .insert(sequences)
    .values([
      { id: sequenceId, teamId: team.id, title: 'S', styleId: style.id },
    ]);
  const [frame] = await db
    .insert(frames)
    .values({ sequenceId, orderIndex: 0 })
    .returning();
  frameId = frame.id;
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations, casing: 'snake_case' });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('frame_variants partial-index uniqueness', () => {
  it('allows one primary plus N divergent alternates for the same (frame, type, model)', async () => {
    // Primary: divergedAt IS NULL.
    await db.insert(frameVariants).values({
      frameId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/primary.png',
      status: 'completed',
      inputHash: 'primary-hash',
    });

    // Two divergent alternates with distinct input hashes — both legal under
    // the divergent partial unique index because the index keys on
    // (frameId, variantType, model, inputHash) WHERE divergedAt IS NOT NULL.
    await db.insert(frameVariants).values({
      frameId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/divergent-a.png',
      status: 'completed',
      inputHash: 'divergent-hash-a',
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });
    await db.insert(frameVariants).values({
      frameId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/divergent-b.png',
      status: 'completed',
      inputHash: 'divergent-hash-b',
      divergedAt: new Date('2026-04-30T00:00:00Z'),
    });

    const rows = await db.select().from(frameVariants);
    expect(rows).toHaveLength(3);
    expect(rows.filter((r) => r.divergedAt === null)).toHaveLength(1);
    expect(rows.filter((r) => r.divergedAt !== null)).toHaveLength(2);
  });

  it('rejects a second primary row for the same (frame, type, model)', async () => {
    await db.insert(frameVariants).values({
      frameId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/primary-1.png',
      status: 'completed',
    });

    let threw = false;
    try {
      await db.insert(frameVariants).values({
        frameId,
        sequenceId,
        variantType: 'image',
        model: 'nano_banana_2',
        url: 'https://example.com/primary-2.png',
        status: 'completed',
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('rejects a second divergent row with the same (frame, type, model, inputHash)', async () => {
    const divergedAt = new Date('2026-04-29T00:00:00Z');
    await db.insert(frameVariants).values({
      frameId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/divergent-1.png',
      status: 'completed',
      inputHash: 'shared-hash',
      divergedAt,
    });

    let threw = false;
    try {
      await db.insert(frameVariants).values({
        frameId,
        sequenceId,
        variantType: 'image',
        model: 'nano_banana_2',
        url: 'https://example.com/divergent-2.png',
        status: 'completed',
        inputHash: 'shared-hash',
        divergedAt,
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe('createFrameVariantsMethods', () => {
  it('getByFrameAndModel returns the primary row even when divergent alternates exist', async () => {
    const methods = createFrameVariantsMethods(asDatabase(db));

    await db.insert(frameVariants).values({
      frameId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/primary.png',
      status: 'completed',
    });
    await db.insert(frameVariants).values({
      frameId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/divergent.png',
      status: 'completed',
      inputHash: 'divergent-hash',
      divergedAt: new Date('2026-04-29T00:00:00Z'),
    });

    const result = await methods.getByFrameAndModel(
      frameId,
      'image',
      'nano_banana_2'
    );

    expect(result).not.toBeNull();
    expect(result?.url).toBe('https://example.com/primary.png');
    expect(result?.divergedAt).toBeNull();
  });

  it('insertDivergent is idempotent on the same (frame, type, model, inputHash)', async () => {
    const methods = createFrameVariantsMethods(asDatabase(db));

    // Primary must exist first — image-workflow's dual-write writes it.
    await db.insert(frameVariants).values({
      frameId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/primary.png',
      status: 'completed',
    });

    const divergedAt = new Date('2026-04-29T00:00:00Z');

    const first = await methods.insertDivergent({
      frameId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/divergent.png',
      status: 'completed',
      inputHash: 'divergent-hash',
      divergedAt,
    });
    expect(first).not.toBeNull();

    // Second call — simulates a QStash retry of the reconcile step. Must not
    // throw and must not create a second row.
    const second = await methods.insertDivergent({
      frameId,
      sequenceId,
      variantType: 'image',
      model: 'nano_banana_2',
      url: 'https://example.com/divergent.png',
      status: 'completed',
      inputHash: 'divergent-hash',
      divergedAt,
    });
    expect(second).toBeNull();

    const rows = await db.select().from(frameVariants);
    expect(rows.filter((r) => r.divergedAt !== null)).toHaveLength(1);
  });
});
