/**
 * Test Database Client for E2E Tests
 * Drizzle ORM instance pointing to test.db, or to the wrangler-local D1
 * sqlite when full-pipeline is enabled (so fixtures and the workerd
 * webserver share a single SQLite file).
 */

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { relations } from '@/lib/db/schema/relations';

const dbPath = process.env.E2E_DB_PATH ?? 'test.db';
const client = createClient({ url: `file:${dbPath}` });

// busy_timeout waits for locks instead of failing immediately during parallel tests
// WAL mode is set by CI workflow and global-setup, not here (avoids SQLITE_BUSY_RECOVERY on stale WAL files)
const initPromise = (async () => {
  await client.execute('PRAGMA busy_timeout = 30000');
})();

/**
 * Drizzle database instance for e2e tests
 * Uses test.db (same as e2e dev server)
 */
export const testDb = drizzle({
  client,
  relations,
});

/**
 * Ensure database is initialized before running queries
 * Call this at the start of test setup if needed
 */
export const ensureDbInit = () => initPromise;

/**
 * Get the raw libSQL client for operations that need it
 * (e.g., PRAGMA commands, dynamic table operations)
 */
export const getTestClient = () => client;
