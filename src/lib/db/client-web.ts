// import { getEnv } from '#env';
import { getEnv } from '#env';
import { createClient, type Client as LibsqlClient } from '@libsql/client/web';
import { drizzle, LibSQLDatabase } from 'drizzle-orm/libsql';
import { schema } from './schema';

console.log('[db-web] Loading client');

type Database = LibSQLDatabase<typeof schema>;

// Global database instance but locally scoped to the file
let _db: Database | undefined;

function buildLibsqlClient(): LibsqlClient {
  const env = getEnv();
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- process.env values can be undefined at runtime
  const url = env.TURSO_DATABASE_URL?.trim();
  if (!url) {
    throw new Error('TURSO_DATABASE_URL env var is not defined');
  }

  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- process.env values can be undefined at runtime
  const authToken = env.TURSO_AUTH_TOKEN?.trim();
  if (!authToken) {
    throw new Error('TURSO_AUTH_TOKEN env var is not defined');
  }

  return createClient({ url, authToken });
}

export const getDb = (): Database => {
  if (_db) return _db;

  /**
   * libSQL client instance
   * Connects to Turso database (cloud) or local SQLite file
   * - For local development: use file: URLs (e.g., file:local.db)
   * - For production: use https:// URLs with auth token
   */
  const client = buildLibsqlClient();

  /**
   * Drizzle database instance
   * Uses the libSQL client and includes all schema definitions
   * Configured to use snake_case in database and camelCase in application
   */
  _db = drizzle(client, {
    schema,
    logger: getEnv().NODE_ENV === 'development',
    casing: 'snake_case',
  });

  return _db;
};
