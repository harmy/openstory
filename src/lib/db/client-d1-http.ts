/**
 * Drizzle Database Client - Cloudflare D1 via HTTP API
 * Used by CI scripts (seed, etc.) that run outside Cloudflare Workers.
 *
 * Uses the /raw endpoint exclusively so results come back as positional
 * arrays — required by drizzle-orm/sqlite-proxy's mapResultRow when
 * casing: 'snake_case' is enabled.
 */

import { drizzle } from 'drizzle-orm/sqlite-proxy';
import { relations } from './schema/relations';

type D1RawResponse = {
  success: boolean;
  errors: Array<{ code: number; message: string }>;
  result: Array<{
    results: { columns: string[]; rows: unknown[][] };
    success: boolean;
  }>;
};

export function createD1HttpClient(opts: {
  accountId: string;
  databaseId: string;
  token: string;
}) {
  const url = `https://api.cloudflare.com/client/v4/accounts/${opts.accountId}/d1/database/${opts.databaseId}/raw`;

  const remoteCallback = async (
    sql: string,
    params: unknown[],
    method: 'run' | 'all' | 'values' | 'get'
  ) => {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sql, params }),
    });
    const data: D1RawResponse = await res.json();
    if (!data.success) {
      throw new Error(
        data.errors.map((e) => `${e.code}: ${e.message}`).join('\n')
      );
    }
    const rawResult = data.result[0].results;
    if (method === 'run') {
      return { rows: [] as unknown[] };
    }
    // /raw returns { columns: string[], rows: unknown[][] }
    // sqlite-proxy expects { rows: unknown[][] } for all/get/values
    return { rows: rawResult.rows };
  };

  return drizzle(remoteCallback, { relations, casing: 'snake_case' });
}
