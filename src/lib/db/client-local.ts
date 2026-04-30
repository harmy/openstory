/**
 * Drizzle Database Client — local development
 * Uses Bun's native sqlite for zero external dependencies.
 */

import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { relations } from './schema/relations';

console.log('[db-local] Loading client');

const dbUrl = process.env.DATABASE_URL || 'file:local.db';
const filename = dbUrl.startsWith('file:')
  ? dbUrl.slice('file:'.length)
  : dbUrl;
const sqlite = new Database(filename, { create: true });

// Wait for locks instead of failing with SQLITE_BUSY when concurrent queries collide.
sqlite.prepare('PRAGMA busy_timeout = 5000').run();

const _db = drizzle({
  client: sqlite,
  relations,
  logger: false,
  casing: 'snake_case',
});

export const getDb = () => _db;
