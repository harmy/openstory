/**
 * In-memory DB tests for per-scope `resolveKey` memoization (issue #864).
 *
 * `resolveKey` previously ran a fresh D1 SELECT on `team_api_keys` for every
 * LLM/fal sub-call; under the #801 90-sequence burst the redundant identical
 * reads exhausted D1 and hard-failed sequences in phase 3. A `ScopedDb` is
 * built once per workflow run / request, so memoizing the row lookup on the
 * read-methods closure caps it to one read per provider per scope — with the
 * cache lifetime bounded to that one run, there is no cross-run staleness, and
 * the write methods invalidate the cache so a rotation within a scope can't
 * keep serving the old key.
 *
 * Security: the cache holds the *encrypted* row only; `resolveKey` decrypts
 * fresh on every call, so the plaintext key is never retained in the cache (the
 * `decryptSpy` test pins this).
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import { teamApiKeys, teams, user } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

vi.doMock('#env', () => ({
  getEnv: () => ({
    API_KEY_ENCRYPTION_KEY: 'test-secret-for-api-keys-memoization',
    OPENROUTER_KEY: 'platform-openrouter-key',
    FAL_KEY: 'platform-fal-key',
  }),
}));

// Wrap the real `decryptApiKey` in a spy (delegating to the actual impl) so a
// test can assert decryption runs once per call — i.e. the cache holds
// ciphertext, not plaintext. `encryptApiKey` stays real so `saveKey` round-trips.
const decryptSpy = vi.fn();
vi.doMock('@/lib/crypto/api-key-encryption', async () => {
  const actual = await vi.importActual<
    typeof import('@/lib/crypto/api-key-encryption')
  >('@/lib/crypto/api-key-encryption');
  decryptSpy.mockImplementation(actual.decryptApiKey);
  return { ...actual, decryptApiKey: decryptSpy };
});

// Dynamic import so the mocks above apply to the module-under-test (and its
// crypto dependency) — see CLAUDE.md module-mocking pattern.
const { createApiKeysMethods, createApiKeysReadMethods } =
  await import('./api-keys');

let client: Client;
let db: Database;
let teamId = '';
let userId = '';

/**
 * Wrap `db` in a Proxy that tallies every `select` so a test can assert how
 * many D1 reads a sequence of `resolveKey` calls actually issued. All methods
 * are bound to the real db so drizzle's internals still see the right `this`.
 */
function countingDb(): { db: Database; selects: () => number } {
  let selects = 0;
  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'select') selects++;
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: proxy, selects: () => selects };
}

async function seed() {
  await db.delete(teamApiKeys);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
  userId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: `t-${teamId}` });
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: `${userId}@example.com` });
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

describe('resolveKey memoization (issue #864)', () => {
  it('reads team_api_keys once across repeated resolveKey calls in one scope', async () => {
    await createApiKeysMethods(db, teamId, userId).saveKey({
      provider: 'openrouter',
      apiKey: 'sk-team-123',
    });

    const { db: cdb, selects } = countingDb();
    const scope = createApiKeysReadMethods(cdb, teamId);

    const r1 = await scope.resolveKey('openrouter');
    const r2 = await scope.resolveKey('openrouter');
    const r3 = await scope.resolveKey('openrouter');

    expect(r1).toEqual({ key: 'sk-team-123', source: 'team' });
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
    expect(selects()).toBe(1);
  });

  it('decrypts per call and never caches the plaintext key', async () => {
    await createApiKeysMethods(db, teamId, userId).saveKey({
      provider: 'openrouter',
      apiKey: 'sk-secret',
    });

    const { db: cdb, selects } = countingDb();
    const scope = createApiKeysReadMethods(cdb, teamId);

    decryptSpy.mockClear();
    await scope.resolveKey('openrouter');
    await scope.resolveKey('openrouter');
    await scope.resolveKey('openrouter');

    // One D1 read (the row is cached) but a fresh decrypt on every call — the
    // plaintext is re-derived per call, never held in the cache.
    expect(selects()).toBe(1);
    expect(decryptSpy).toHaveBeenCalledTimes(3);
  });

  it('collapses concurrent in-flight resolves to a single read', async () => {
    await createApiKeysMethods(db, teamId, userId).saveKey({
      provider: 'openrouter',
      apiKey: 'sk-team-concurrent',
    });

    const { db: cdb, selects } = countingDb();
    const scope = createApiKeysReadMethods(cdb, teamId);

    const [r1, r2, r3] = await Promise.all([
      scope.resolveKey('openrouter'),
      scope.resolveKey('openrouter'),
      scope.resolveKey('openrouter'),
    ]);

    expect(r1).toEqual({ key: 'sk-team-concurrent', source: 'team' });
    expect(r2).toEqual(r1);
    expect(r3).toEqual(r1);
    expect(selects()).toBe(1);
  });

  it('caches each provider independently (one read per provider)', async () => {
    const writeScope = createApiKeysMethods(db, teamId, userId);
    await writeScope.saveKey({ provider: 'openrouter', apiKey: 'sk-or' });
    await writeScope.saveKey({ provider: 'fal', apiKey: 'sk-fal' });

    const { db: cdb, selects } = countingDb();
    const scope = createApiKeysReadMethods(cdb, teamId);

    await scope.resolveKey('openrouter');
    await scope.resolveKey('fal');
    await scope.resolveKey('openrouter');
    await scope.resolveKey('fal');

    expect(selects()).toBe(2);
  });

  it('memoizes the platform fallback when the team has no key', async () => {
    const { db: cdb, selects } = countingDb();
    const scope = createApiKeysReadMethods(cdb, teamId);

    const r1 = await scope.resolveKey('fal');
    const r2 = await scope.resolveKey('fal');

    expect(r1).toEqual({ key: 'platform-fal-key', source: 'platform' });
    expect(r2).toEqual(r1);
    expect(selects()).toBe(1);
  });

  it('re-reads in a fresh scope (cache lifetime is one scope)', async () => {
    await createApiKeysMethods(db, teamId, userId).saveKey({
      provider: 'openrouter',
      apiKey: 'sk-team-456',
    });

    const first = countingDb();
    await createApiKeysReadMethods(first.db, teamId).resolveKey('openrouter');
    expect(first.selects()).toBe(1);

    const second = countingDb();
    const r = await createApiKeysReadMethods(second.db, teamId).resolveKey(
      'openrouter'
    );
    expect(r).toEqual({ key: 'sk-team-456', source: 'team' });
    expect(second.selects()).toBe(1);
  });

  it('re-reads after a key is rotated within the same scope', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);

    await scope.saveKey({ provider: 'openrouter', apiKey: 'sk-v1' });
    const r1 = await scope.resolveKey('openrouter');
    expect(r1).toEqual({ key: 'sk-v1', source: 'team' });

    // Rotating the key invalidates the cached resolve; the next call must see
    // the new value, not the stale v1 it just cached.
    await scope.saveKey({ provider: 'openrouter', apiKey: 'sk-v2' });
    const r2 = await scope.resolveKey('openrouter');
    expect(r2).toEqual({ key: 'sk-v2', source: 'team' });
  });

  it('re-reads after the key is deleted within the same scope', async () => {
    const scope = createApiKeysMethods(db, teamId, userId);

    await scope.saveKey({ provider: 'openrouter', apiKey: 'sk-team-del' });
    expect(await scope.resolveKey('openrouter')).toEqual({
      key: 'sk-team-del',
      source: 'team',
    });

    await scope.deleteKey('openrouter');
    expect(await scope.resolveKey('openrouter')).toEqual({
      key: 'platform-openrouter-key',
      source: 'platform',
    });
  });

  it('does not cache a failed resolve, so a retry can re-read', async () => {
    await createApiKeysMethods(db, teamId, userId).saveKey({
      provider: 'openrouter',
      apiKey: 'sk-team-xyz',
    });

    let selectCalls = 0;
    const flakyDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'select') {
          selectCalls++;
          if (selectCalls === 1) {
            // Simulate a transient D1 overload on the very first read.
            return () => ({
              from: () => ({
                where: () => ({
                  limit: () => Promise.reject(new Error('D1 overloaded')),
                }),
              }),
            });
          }
        }
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    const scope = createApiKeysReadMethods(flakyDb, teamId);

    await expect(scope.resolveKey('openrouter')).rejects.toThrow(
      'D1 overloaded'
    );
    // The rejection must have been evicted — a second call re-reads and wins.
    const r = await scope.resolveKey('openrouter');
    expect(r).toEqual({ key: 'sk-team-xyz', source: 'team' });
  });
});
