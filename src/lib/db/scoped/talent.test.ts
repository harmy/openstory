/**
 * Integration tests for the v1 RQB predicate shape used by scoped talent
 * queries: `where: { id, OR: [{ teamId }, { isPublic: true }] }`.
 *
 * The wrappers in `./talent` are trivial pass-throughs over `db.query.talent`,
 * so we exercise the predicate shape directly. The point is to confirm
 * Drizzle v1 translates `{ id, OR: [...] }` to `id = ? AND (... OR ...)` —
 * NOT to `id = ? OR ... OR ...` — which would be a cross-tenant data leak.
 *
 * Sibling test files mock `@/lib/db/scoped/talent` via `mock.module` (Bun
 * applies this process-wide), so importing the wrappers here yields stubs.
 * Direct `db.query.talent.findFirst` calls avoid the polluted module ID.
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
import { talent, teams, user } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';

type TestDb = LibSQLDatabase<Record<string, never>, typeof relations>;

let client: Client;
let db: TestDb;

const teamA = { id: '', name: 'Team A', slug: 'team-a' };
const teamB = { id: '', name: 'Team B', slug: 'team-b' };
const teamC = { id: '', name: 'Team C', slug: 'team-c' };
const userA = { id: '', name: 'User A', email: 'a@example.com' };

async function seedFixtures() {
  await db.delete(talent);
  await db.delete(teams);
  await db.delete(user);

  teamA.id = generateId();
  teamB.id = generateId();
  teamC.id = generateId();
  userA.id = generateId();

  await db
    .insert(user)
    .values([{ id: userA.id, name: userA.name, email: userA.email }]);
  await db.insert(teams).values([teamA, teamB, teamC]);
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
  await seedFixtures();
});

describe('talent v1 RQB OR predicate (cross-tenant isolation)', () => {
  it('matches own talent (id + own team)', async () => {
    const [own] = await db
      .insert(talent)
      .values({ teamId: teamA.id, name: 'A-private', isPublic: false })
      .returning();

    const found = await db.query.talent.findFirst({
      where: {
        id: own.id,
        OR: [{ teamId: teamA.id }, { isPublic: true }],
      },
    });

    expect(found?.id).toBe(own.id);
  });

  it('matches public talent owned by another team', async () => {
    const [pub] = await db
      .insert(talent)
      .values({ teamId: teamC.id, name: 'C-public', isPublic: true })
      .returning();

    const found = await db.query.talent.findFirst({
      where: {
        id: pub.id,
        OR: [{ teamId: teamA.id }, { isPublic: true }],
      },
    });

    expect(found?.id).toBe(pub.id);
  });

  it('does NOT match another team’s private talent (the leak case)', async () => {
    const [other] = await db
      .insert(talent)
      .values({ teamId: teamB.id, name: 'B-private', isPublic: false })
      .returning();

    const found = await db.query.talent.findFirst({
      where: {
        id: other.id,
        OR: [{ teamId: teamA.id }, { isPublic: true }],
      },
    });

    // If v1 misinterpreted the predicate as `id = ? OR teamId = ? OR ...`,
    // the row would come back here. It must not.
    expect(found).toBeUndefined();
  });

  it('does NOT match another team’s private talent even when querying by id only with a wide OR', async () => {
    const [other] = await db
      .insert(talent)
      .values({ teamId: teamB.id, name: 'B-private', isPublic: false })
      .returning();

    // Sanity: the row exists when queried unscoped.
    const unscoped = await db.query.talent.findFirst({
      where: { id: other.id },
    });
    expect(unscoped?.id).toBe(other.id);

    // Scoped: must not return it.
    const scoped = await db.query.talent.findFirst({
      where: {
        id: other.id,
        OR: [{ teamId: teamA.id }, { isPublic: true }],
      },
    });
    expect(scoped).toBeUndefined();
  });

  it('list-style query returns own + public, never another team’s private', async () => {
    await db.insert(talent).values([
      { teamId: teamA.id, name: 'A-private', isPublic: false },
      { teamId: teamB.id, name: 'B-private', isPublic: false },
      { teamId: teamC.id, name: 'C-public', isPublic: true },
    ]);

    const rows = await db.query.talent.findMany({
      where: {
        OR: [{ teamId: teamA.id }, { isPublic: true }],
      },
    });

    const names = rows.map((r) => r.name).sort();
    expect(names).toEqual(['A-private', 'C-public']);
    expect(names).not.toContain('B-private');
  });
});
