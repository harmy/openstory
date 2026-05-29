/**
 * Apply Drizzle migrations to the Wrangler-managed local D1.
 *
 * `wrangler d1 migrations apply --local` expects flat `.sql` files in the
 * migrations_dir, but drizzle-kit nests them as `<timestamp>_<name>/migration.sql`
 * with a sibling `meta/` folder containing journal + snapshot JSON. wrangler
 * silently finds zero files and marks migrations as "applied", leaving the
 * D1 schema empty.
 *
 * This script uses drizzle-orm's d1 migrator against the binding handed back
 * by `getPlatformProxy()` — the same Miniflare-backed D1 that `wrangler dev`
 * (and the cf-plugin under `vite dev`) read/write. So schema applied here
 * shows up under the cf-plugin's worker at runtime, no out-of-band sync.
 *
 * Usage:
 *   bun scripts/migrate-local-d1.ts            # default env (dev)
 *   bun scripts/migrate-local-d1.ts --test     # [env.test] block
 */

import { drizzle } from 'drizzle-orm/d1';
import { migrate } from 'drizzle-orm/d1/migrator';
import { getPlatformProxy } from 'wrangler';

const isTest = process.argv.includes('--test');
const environment = isTest ? 'test' : undefined;

// remoteBindings: false skips wrangler's remote-proxy session for any
// `remote: true` bindings in wrangler.jsonc (R2 buckets in [env.test]).
// We only touch local D1 here, so the proxy session would just demand a
// CLOUDFLARE_API_TOKEN we don't need for migrations.
const proxy = await getPlatformProxy<{ DB?: D1Database }>({
  environment,
  remoteBindings: false,
});
const d1 = proxy.env.DB;
if (!d1) {
  throw new Error(
    `[migrate-local-d1] D1 binding 'DB' missing from wrangler.jsonc ${environment ? `[env.${environment}]` : '(default)'}`
  );
}

console.log(
  `[migrate-local-d1] Applying drizzle/migrations to local D1 (${environment ?? 'default'} env)…`
);
try {
  const db = drizzle(d1);
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
  console.log('[migrate-local-d1] ✅ migrations applied');
} finally {
  await proxy.dispose();
}
