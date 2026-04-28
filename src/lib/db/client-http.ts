/**
 * Drizzle Database Client
 * Centralized database client using libSQL (Turso)
 */

import { getEnv } from '#env';
import { createClient } from '@libsql/client/http';
import { drizzle } from 'drizzle-orm/libsql';
import { relations } from './schema/relations';
// @ts-ignore - resolved via package.json imports

console.log('[db-http] Loading client');

type Database = ReturnType<typeof buildDb>;

let _db: Database | undefined;

export const getDb = (): Database => {
  if (_db) return _db;

  const tursoUrl = getEnv().TURSO_DATABASE_URL;
  const tursoToken = getEnv().TURSO_AUTH_TOKEN;

  if (!tursoUrl) {
    throw new Error('TURSO_DATABASE_URL is required');
  }

  /**
   * libSQL client instance
   * Connects to Turso database (cloud) or local SQLite file
   * - For local development: use file: URLs (e.g., file:local.db)
   * - For production: use https:// URLs with auth token
   */
  const client = createClient({
    url: tursoUrl,
    ...(tursoToken && { authToken: tursoToken }), // Only include if defined
  });

  /**
   * Drizzle database instance
   * Uses the libSQL client and includes all schema definitions
   * Configured to use snake_case in database and camelCase in application
   */
  _db = buildDb(client);

  return _db;
};

function buildDb(client: ReturnType<typeof createClient>) {
  return drizzle({
    client,
    relations,
    logger: getEnv().NODE_ENV === 'development',
    casing: 'snake_case',
  });
}
