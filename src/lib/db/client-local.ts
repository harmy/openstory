/**
 * Drizzle Database Client
 * Centralized database client using libSQL (Turso)
 */

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { relations } from './schema/relations';

console.log('[db-local] Loading client');

const dbUrl = process.env.DATABASE_URL || 'file:local.db';
const client = createClient({ url: dbUrl });

// Set busy_timeout so concurrent queries wait for locks instead of failing with SQLITE_BUSY
client.execute('PRAGMA busy_timeout = 5000').catch(() => {
  // Ignore errors (e.g. remote Turso connections don't support PRAGMAs)
});

/**
 * Drizzle database instance
 * Uses the libSQL client and includes all schema definitions
 * Configured to use snake_case in database and camelCase in application
 */
const _db = drizzle({
  client,
  relations,
  logger: false,
  casing: 'snake_case',
});

export const getDb = () => _db;
