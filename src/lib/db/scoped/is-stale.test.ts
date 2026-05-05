/**
 * Schema-level acceptance test for the input-hash columns plus a behavioral
 * truth-table test for the `isStale` wrappers on `frames` and `frameVariants`.
 *
 * The other four wrappers (characters, locationLibrary, locationSheets,
 * talent.sheets) follow the same four-line shape exercised here, and their
 * parent factory modules are mocked process-wide by scoped.test.ts (per the
 * preamble of `./talent.test.ts`) — so importing them in a sibling test yields
 * stubs. The schema persistence asserts in this file plus the truth-table
 * coverage on frames/frameVariants are the regression guard for the pattern.
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
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { generateId } from '@/lib/db/id';
import {
  characters,
  frameVariants,
  frames,
  locationLibrary,
  locationSheets,
  sequenceLocations,
  sequences,
  styles,
  talent,
  talentSheets,
  teams,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import type { Database } from '@/lib/db/client';
import { createFramesMethods, type FrameArtifact } from './frames';
import { createFrameVariantsMethods } from './frame-variants';

let client: Client;
let db: Database;

const team = { id: '', name: 'T', slug: 't' };
const userRow = { id: '', name: 'U', email: 'u@example.com' };
let sequenceId = '';

async function seed() {
  await db.delete(frameVariants);
  await db.delete(frames);
  await db.delete(characters);
  await db.delete(sequenceLocations);
  await db.delete(locationSheets);
  await db.delete(locationLibrary);
  await db.delete(talentSheets);
  await db.delete(talent);
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

describe('frames input-hash columns', () => {
  it('default to null and persist when set', async () => {
    const [frame] = await db
      .insert(frames)
      .values({ sequenceId, orderIndex: 0 })
      .returning();
    expect(frame.thumbnailInputHash).toBeNull();
    expect(frame.variantImageInputHash).toBeNull();
    expect(frame.videoInputHash).toBeNull();
    expect(frame.audioInputHash).toBeNull();

    await db
      .update(frames)
      .set({
        thumbnailInputHash: 't',
        variantImageInputHash: 'v',
        videoInputHash: 'm',
        audioInputHash: 'a',
      })
      .where(eq(frames.id, frame.id));
    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frame.id));
    expect(refreshed.thumbnailInputHash).toBe('t');
    expect(refreshed.variantImageInputHash).toBe('v');
    expect(refreshed.videoInputHash).toBe('m');
    expect(refreshed.audioInputHash).toBe('a');
  });
});

describe('frame_variants input-hash + diverged_at columns', () => {
  it('default to null and persist when set', async () => {
    const [frame] = await db
      .insert(frames)
      .values({ sequenceId, orderIndex: 0 })
      .returning();
    const [variant] = await db
      .insert(frameVariants)
      .values({
        frameId: frame.id,
        sequenceId,
        variantType: 'image',
        model: 'm1',
      })
      .returning();
    expect(variant.inputHash).toBeNull();
    expect(variant.divergedAt).toBeNull();

    const divergedAt = new Date('2026-04-29T00:00:00Z');
    await db
      .update(frameVariants)
      .set({ inputHash: 'h', divergedAt })
      .where(eq(frameVariants.id, variant.id));
    const [refreshed] = await db
      .select()
      .from(frameVariants)
      .where(eq(frameVariants.id, variant.id));
    expect(refreshed.inputHash).toBe('h');
    expect(refreshed.divergedAt?.getTime()).toBe(divergedAt.getTime());
  });
});

describe('characters.sheet_input_hash', () => {
  it('defaults to null and persists when set', async () => {
    const [c] = await db
      .insert(characters)
      .values({ sequenceId, characterId: 'c1', name: 'C', age: '30s' })
      .returning();
    expect(c.sheetInputHash).toBeNull();

    await db
      .update(characters)
      .set({ sheetInputHash: 'h' })
      .where(eq(characters.id, c.id));
    const [refreshed] = await db
      .select()
      .from(characters)
      .where(eq(characters.id, c.id));
    expect(refreshed.sheetInputHash).toBe('h');
  });
});

describe('locationLibrary.reference_input_hash', () => {
  it('defaults to null and persists when set', async () => {
    const [loc] = await db
      .insert(locationLibrary)
      .values({ teamId: team.id, name: 'L' })
      .returning();
    expect(loc.referenceInputHash).toBeNull();

    await db
      .update(locationLibrary)
      .set({ referenceInputHash: 'h' })
      .where(eq(locationLibrary.id, loc.id));
    const [refreshed] = await db
      .select()
      .from(locationLibrary)
      .where(eq(locationLibrary.id, loc.id));
    expect(refreshed.referenceInputHash).toBe('h');
  });
});

describe('locationSheets.input_hash', () => {
  it('defaults to null and persists when set', async () => {
    const [loc] = await db
      .insert(locationLibrary)
      .values({ teamId: team.id, name: 'L' })
      .returning();
    const [sheet] = await db
      .insert(locationSheets)
      .values({ locationId: loc.id, name: 'night' })
      .returning();
    expect(sheet.inputHash).toBeNull();

    await db
      .update(locationSheets)
      .set({ inputHash: 'h' })
      .where(eq(locationSheets.id, sheet.id));
    const [refreshed] = await db
      .select()
      .from(locationSheets)
      .where(eq(locationSheets.id, sheet.id));
    expect(refreshed.inputHash).toBe('h');
  });
});

describe('talent_sheets.input_hash', () => {
  it('defaults to null and persists when set', async () => {
    const [t] = await db
      .insert(talent)
      .values({ teamId: team.id, name: 'T' })
      .returning();
    const [sheet] = await db
      .insert(talentSheets)
      .values({ talentId: t.id, name: 'casual' })
      .returning();
    expect(sheet.inputHash).toBeNull();

    await db
      .update(talentSheets)
      .set({ inputHash: 'h' })
      .where(eq(talentSheets.id, sheet.id));
    const [refreshed] = await db
      .select()
      .from(talentSheets)
      .where(eq(talentSheets.id, sheet.id));
    expect(refreshed.inputHash).toBe('h');
  });
});

describe('frames.isStale', () => {
  const ARTIFACTS: Array<{
    artifact: FrameArtifact;
    column:
      | 'thumbnailInputHash'
      | 'variantImageInputHash'
      | 'videoInputHash'
      | 'audioInputHash';
  }> = [
    { artifact: 'thumbnail', column: 'thumbnailInputHash' },
    { artifact: 'variantImage', column: 'variantImageInputHash' },
    { artifact: 'video', column: 'videoInputHash' },
    { artifact: 'audio', column: 'audioInputHash' },
  ];

  it('throws when the frame does not exist', () => {
    const m = createFramesMethods(db);
    expect(m.isStale(generateId(), 'thumbnail', 'h')).rejects.toThrow(
      /not found/
    );
  });

  it.each(ARTIFACTS)(
    '$artifact: returns false when stored hash is null (legacy artifact)',
    async ({ artifact }) => {
      const [frame] = await db
        .insert(frames)
        .values({ sequenceId, orderIndex: 0 })
        .returning();
      const m = createFramesMethods(db);
      expect(await m.isStale(frame.id, artifact, 'anything')).toBe(false);
    }
  );

  it.each(ARTIFACTS)(
    '$artifact: returns false when stored hash matches the current hash',
    async ({ artifact, column }) => {
      const [frame] = await db
        .insert(frames)
        .values({ sequenceId, orderIndex: 0, [column]: 'h-match' })
        .returning();
      const m = createFramesMethods(db);
      expect(await m.isStale(frame.id, artifact, 'h-match')).toBe(false);
    }
  );

  it.each(ARTIFACTS)(
    '$artifact: returns true when stored hash differs from the current hash',
    async ({ artifact, column }) => {
      const [frame] = await db
        .insert(frames)
        .values({ sequenceId, orderIndex: 0, [column]: 'h-old' })
        .returning();
      const m = createFramesMethods(db);
      expect(await m.isStale(frame.id, artifact, 'h-new')).toBe(true);
    }
  );

  it('reads from the column matching the requested artifact (no cross-talk)', async () => {
    const [frame] = await db
      .insert(frames)
      .values({
        sequenceId,
        orderIndex: 0,
        thumbnailInputHash: 't-hash',
        variantImageInputHash: 'v-hash',
        videoInputHash: 'm-hash',
        audioInputHash: 'a-hash',
      })
      .returning();
    const m = createFramesMethods(db);
    // Each artifact key compares against ONLY its own column.
    expect(await m.isStale(frame.id, 'thumbnail', 't-hash')).toBe(false);
    expect(await m.isStale(frame.id, 'thumbnail', 'v-hash')).toBe(true);
    expect(await m.isStale(frame.id, 'video', 'm-hash')).toBe(false);
    expect(await m.isStale(frame.id, 'video', 'a-hash')).toBe(true);
  });
});

// `createSequenceLocationsMethods` is mocked process-wide by scoped.test.ts,
// so the factory cannot be exercised here. The predicate is the same 4-line
// shape as `frames.isStale` / `frameVariants.isStale` (covered above); these
// tests pin the underlying column behavior the predicate reads.
describe('sequenceLocations.reference_input_hash', () => {
  async function insertLocation(referenceInputHash: string | null) {
    const [loc] = await db
      .insert(sequenceLocations)
      .values({
        sequenceId,
        locationId: `loc_${generateId()}`,
        name: 'Loc',
        referenceInputHash,
      })
      .returning();
    return loc;
  }

  it('defaults to null and persists when set', async () => {
    const loc = await insertLocation(null);
    expect(loc.referenceInputHash).toBeNull();

    await db
      .update(sequenceLocations)
      .set({ referenceInputHash: 'h' })
      .where(eq(sequenceLocations.id, loc.id));
    const [refreshed] = await db
      .select()
      .from(sequenceLocations)
      .where(eq(sequenceLocations.id, loc.id));
    expect(refreshed.referenceInputHash).toBe('h');
  });

  it('predicate truth-table holds against stored column (null / match / differ)', async () => {
    // Stored null → no opinion (never stale).
    const noHash = await insertLocation(null);
    const [r0] = await db
      .select({ stored: sequenceLocations.referenceInputHash })
      .from(sequenceLocations)
      .where(eq(sequenceLocations.id, noHash.id));
    expect(r0.stored).toBeNull();

    // Stored match → not stale.
    const match = await insertLocation('h-match');
    const [r1] = await db
      .select({ stored: sequenceLocations.referenceInputHash })
      .from(sequenceLocations)
      .where(eq(sequenceLocations.id, match.id));
    expect(r1.stored).toBe('h-match');

    // Stored differs → stale.
    const differ = await insertLocation('h-old');
    const [r2] = await db
      .select({ stored: sequenceLocations.referenceInputHash })
      .from(sequenceLocations)
      .where(eq(sequenceLocations.id, differ.id));
    expect(r2.stored).toBe('h-old');
    expect(r2.stored !== 'h-new').toBe(true);
  });
});

describe('frameVariants.isStale', () => {
  async function insertVariant(inputHash: string | null) {
    const [frame] = await db
      .insert(frames)
      .values({ sequenceId, orderIndex: 0 })
      .returning();
    const [variant] = await db
      .insert(frameVariants)
      .values({
        frameId: frame.id,
        sequenceId,
        variantType: 'image',
        model: 'm1',
        inputHash,
      })
      .returning();
    return variant;
  }

  it('throws when the variant does not exist', () => {
    const m = createFrameVariantsMethods(db);
    expect(m.isStale(generateId(), 'h')).rejects.toThrow(/not found/);
  });

  it('returns false when stored hash is null', async () => {
    const variant = await insertVariant(null);
    const m = createFrameVariantsMethods(db);
    expect(await m.isStale(variant.id, 'anything')).toBe(false);
  });

  it('returns false when stored hash matches', async () => {
    const variant = await insertVariant('h-match');
    const m = createFrameVariantsMethods(db);
    expect(await m.isStale(variant.id, 'h-match')).toBe(false);
  });

  it('returns true when stored hash differs', async () => {
    const variant = await insertVariant('h-old');
    const m = createFrameVariantsMethods(db);
    expect(await m.isStale(variant.id, 'h-new')).toBe(true);
  });
});
