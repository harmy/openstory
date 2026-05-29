/**
 * Unit tests for the race-tolerant divergent-insert helper and its
 * unique-constraint detector. These pin behavior across the three SQLite
 * driver shapes we expect to encounter:
 *   - `@libsql/client` LibsqlError with `extendedCode`
 *   - `better-sqlite3`-style Error with `code`
 *   - Cloudflare D1's plain Error with the canonical SQLite message text
 */

import { describe, expect, it } from 'vitest';
import {
  insertDivergentRaceTolerant,
  isUniqueConstraintError,
} from './divergent-insert';

describe('isUniqueConstraintError', () => {
  it('matches @libsql/client extendedCode', () => {
    const err = Object.assign(new Error('boom'), {
      code: 'SQLITE_CONSTRAINT',
      extendedCode: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    expect(isUniqueConstraintError(err)).toBe(true);
  });

  it('matches better-sqlite3-style code on the unique extended value', () => {
    const err = Object.assign(new Error('boom'), {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    expect(isUniqueConstraintError(err)).toBe(true);
  });

  it('matches PRIMARY KEY uniqueness as a unique-constraint violation', () => {
    const err = Object.assign(new Error('boom'), {
      code: 'SQLITE_CONSTRAINT_PRIMARYKEY',
    });
    expect(isUniqueConstraintError(err)).toBe(true);
  });

  it('matches Cloudflare D1 plain Error via the canonical message text', () => {
    const err = new Error(
      'D1_ERROR: UNIQUE constraint failed: character_sheet_variants.input_hash'
    );
    expect(isUniqueConstraintError(err)).toBe(true);
  });

  it('does not match a foreign-key constraint violation', () => {
    const err = new Error('FOREIGN KEY constraint failed');
    expect(isUniqueConstraintError(err)).toBe(false);
  });

  it('does not match a NOT NULL constraint violation', () => {
    const err = new Error('NOT NULL constraint failed: characters.name');
    expect(isUniqueConstraintError(err)).toBe(false);
  });

  it('does not match an unrelated error', () => {
    expect(isUniqueConstraintError(new Error('connection lost'))).toBe(false);
    expect(isUniqueConstraintError('string')).toBe(false);
    expect(isUniqueConstraintError(undefined)).toBe(false);
    expect(isUniqueConstraintError(null)).toBe(false);
  });
});

describe('insertDivergentRaceTolerant', () => {
  type Row = { id: string };

  it('returns the pre-existing row without calling insert', async () => {
    let insertCalls = 0;
    const result = await insertDivergentRaceTolerant<Row>({
      findExisting: async () => [{ id: 'existing' }],
      insert: async () => {
        insertCalls += 1;
        return [{ id: 'inserted' }];
      },
      errorMessage: 'should not happen',
    });
    expect(result.id).toBe('existing');
    expect(insertCalls).toBe(0);
  });

  it('inserts when nothing exists yet', async () => {
    const result = await insertDivergentRaceTolerant<Row>({
      findExisting: async () => [],
      insert: async () => [{ id: 'inserted' }],
      errorMessage: 'fail',
    });
    expect(result.id).toBe('inserted');
  });

  it('absorbs a cross-run race: pre-check empty, INSERT raises unique, re-fetch returns winner', async () => {
    let findCalls = 0;
    const winner: Row = { id: 'race-winner' };

    const result = await insertDivergentRaceTolerant<Row>({
      findExisting: async () => {
        findCalls += 1;
        // First call (pre-check) sees an empty table; the racing run
        // commits between this call and our INSERT. Second call (after
        // the unique-constraint retry) finds the winner.
        return findCalls === 1 ? [] : [winner];
      },
      insert: async () => {
        throw Object.assign(new Error('UNIQUE constraint failed'), {
          code: 'SQLITE_CONSTRAINT_UNIQUE',
        });
      },
      errorMessage: 'unused',
    });

    expect(result.id).toBe('race-winner');
    expect(findCalls).toBe(2);
  });

  it('rethrows when INSERT raises a unique-constraint AND re-fetch is empty (different constraint)', async () => {
    // Simulates a unique-constraint violation on a DIFFERENT index than
    // the one `findExisting` matches — must not be silently absorbed.
    expect.assertions(1);
    try {
      await insertDivergentRaceTolerant<Row>({
        findExisting: async () => [],
        insert: async () => {
          throw Object.assign(
            new Error('UNIQUE constraint failed: other_table.other_col'),
            { code: 'SQLITE_CONSTRAINT_UNIQUE' }
          );
        },
        errorMessage: 'fail',
      });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      expect(err.message).toMatch(/UNIQUE constraint failed/);
    }
  });

  it('rethrows non-unique errors immediately without re-fetching', async () => {
    let findCalls = 0;
    expect.assertions(2);
    try {
      await insertDivergentRaceTolerant<Row>({
        findExisting: async () => {
          findCalls += 1;
          return [];
        },
        insert: async () => {
          throw new Error('connection reset');
        },
        errorMessage: 'fail',
      });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      expect(err.message).toBe('connection reset');
    }
    expect(findCalls).toBe(1); // pre-check only; no retry-fetch
  });

  it('throws errorMessage when the INSERT returns an empty array', async () => {
    expect.assertions(1);
    try {
      await insertDivergentRaceTolerant<Row>({
        findExisting: async () => [],
        insert: async () => [],
        errorMessage: 'driver returned no row',
      });
    } catch (err) {
      if (!(err instanceof Error)) throw err;
      expect(err.message).toBe('driver returned no row');
    }
  });
});
