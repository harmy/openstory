/**
 * Drizzle Database Client - Cloudflare D1
 * Used when deploying on Cloudflare Workers/Pages via workerd runtime.
 *
 * D1 is Cloudflare's native serverless SQLite database.
 * The D1 binding is accessed via the `cloudflare:workers` env module.
 */

import { drizzle } from 'drizzle-orm/d1';
import { getEnv } from '../env/cloudflare';
import { relations } from './schema/relations';

console.log('[db-d1] Loading client');

type Database = ReturnType<typeof buildDb>;

let _db: Database | undefined;

export const getDb = (): Database => {
  if (_db) return _db;

  const d1 = getEnv().DB;
  if (!d1) {
    throw new Error(
      'D1 database binding "DB" not found. Ensure d1_databases is configured in wrangler.jsonc'
    );
  }

  _db = buildDb(d1);

  return _db;
};

function buildDb(d1: D1Database) {
  return drizzle(d1, {
    relations,
    casing: 'snake_case',
  });
}
