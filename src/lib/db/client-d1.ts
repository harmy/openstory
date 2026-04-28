/**
 * Drizzle Database Client - Cloudflare D1
 * Used when deploying on Cloudflare Workers/Pages via workerd runtime.
 *
 * D1 is Cloudflare's native serverless SQLite database.
 * The D1 binding is accessed via the `cloudflare:workers` env module.
 */

import { drizzle, type DrizzleD1Database } from 'drizzle-orm/d1';
import { getEnv } from '../env/cloudflare';
import { relations } from './schema/relations';

console.log('[db-d1] Loading client');

type Database = DrizzleD1Database<Record<string, never>, typeof relations>;

let _db: Database | undefined;

export const getDb = (): Database => {
  if (_db) return _db;

  const d1 = getEnv().DB;
  if (!d1) {
    throw new Error(
      'D1 database binding "DB" not found. Ensure d1_databases is configured in wrangler.jsonc'
    );
  }

  _db = drizzle(d1, {
    relations,
    casing: 'snake_case',
  }) as Database;

  return _db;
};
