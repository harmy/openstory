/**
 * In-memory DB tests for getFrameCountsByElement.
 *
 * Pins the two invariants the elements grid relies on:
 *   - Elements with zero matching frames appear in the result map with `0`
 *     (otherwise the badge reads `undefined`).
 *   - A frame that references N elements increments every matched element's
 *     count (no first-match short-circuit).
 */

import { type Client, createClient } from '@libsql/client';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import type { Frame } from '@/lib/db/schema';
import {
  frames,
  sequenceElements,
  sequences,
  styles,
  teams,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { createSequenceElementsMethods } from './sequence-elements';

let client: Client;
let db: Database;
let teamId = '';
let sequenceId = '';

async function seed() {
  await db.delete(frames);
  await db.delete(sequenceElements);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);

  teamId = generateId();
  sequenceId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  const [style] = await db
    .insert(styles)
    .values({
      teamId,
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
  if (!style) throw new Error('test setup: style insert returned nothing');
  await db.insert(sequences).values({
    id: sequenceId,
    teamId,
    title: 'S',
    styleId: style.id,
  });
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

function frameMetadata(args: {
  sceneId: string;
  elementTags: string[];
  extract: string;
}): NonNullable<Frame['metadata']> {
  return {
    sceneId: args.sceneId,
    sceneNumber: 1,
    originalScript: { extract: args.extract, dialogue: [] },
    continuity: {
      environmentTag: '',
      characterTags: [],
      elementTags: args.elementTags,
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
  };
}

describe('getFrameCountsByElement', () => {
  it('returns an empty object when no elements exist', async () => {
    const methods = createSequenceElementsMethods(db);
    const result = await methods.getFrameCountsByElement(sequenceId);
    expect(result).toEqual({});
  });

  it('seeds a zero entry for every element, even those with no matching frames', async () => {
    const methods = createSequenceElementsMethods(db);

    const [unused] = await db
      .insert(sequenceElements)
      .values({
        sequenceId,
        uploadedFilename: 'unused.png',
        token: 'UNUSED',
        imageUrl: 'https://r2/unused.png',
        imagePath: 'elements/x/unused.png',
      })
      .returning();
    if (!unused) throw new Error('test setup: element insert returned nothing');

    const result = await methods.getFrameCountsByElement(sequenceId);
    expect(result[unused.id]?.frameCount).toBe(0);
    expect(result[unused.id]?.videoCount).toBe(0);
  });

  it('counts a frame against every matched element (multi-tag frame increments each)', async () => {
    const methods = createSequenceElementsMethods(db);

    const [logo] = await db
      .insert(sequenceElements)
      .values({
        sequenceId,
        uploadedFilename: 'logo.png',
        token: 'LOGO',
        imageUrl: 'https://r2/logo.png',
        imagePath: 'elements/x/logo.png',
      })
      .returning();
    const [bottle] = await db
      .insert(sequenceElements)
      .values({
        sequenceId,
        uploadedFilename: 'bottle.png',
        token: 'BOTTLE',
        imageUrl: 'https://r2/bottle.png',
        imagePath: 'elements/x/bottle.png',
      })
      .returning();
    const [orphan] = await db
      .insert(sequenceElements)
      .values({
        sequenceId,
        uploadedFilename: 'orphan.png',
        token: 'ORPHAN',
        imageUrl: 'https://r2/orphan.png',
        imagePath: 'elements/x/orphan.png',
      })
      .returning();
    if (!logo || !bottle || !orphan) {
      throw new Error('test setup: element insert returned nothing');
    }

    // Frame referencing both LOGO and BOTTLE via continuity.elementTags.
    await db.insert(frames).values({
      sequenceId,
      orderIndex: 0,
      metadata: frameMetadata({
        sceneId: 's1',
        elementTags: ['LOGO', 'BOTTLE'],
        extract: 'scene script',
      }),
    });

    // Frame referencing only LOGO via script-text fallback (no elementTags).
    await db.insert(frames).values({
      sequenceId,
      orderIndex: 1,
      metadata: frameMetadata({
        sceneId: 's2',
        elementTags: [],
        extract: 'The LOGO appears on screen.',
      }),
    });

    const result = await methods.getFrameCountsByElement(sequenceId);
    expect(result[logo.id]?.frameCount).toBe(2);
    expect(result[bottle.id]?.frameCount).toBe(1);
    expect(result[orphan.id]?.frameCount).toBe(0);
  });
});
