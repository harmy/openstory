import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAimockServer } from './mocks/aimock-server';

/**
 * Playwright global setup.
 *
 * Two modes:
 *   - Hermetic (default): test.db + Nitro server. Mocks workflow triggers
 *     server-side (`triggerWorkflow` short-circuits when E2E_FULL_PIPELINE
 *     is not set).
 *   - Full pipeline (PLAYWRIGHT_FULL_PIPELINE=true): wrangler-local D1 +
 *     workerd server via the Vite Cloudflare plugin. CF Workflows execute
 *     for real. Test fixtures point at the same sqlite via E2E_DB_PATH.
 */

const CF_LOCAL_D1_DIR = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';

function resolveCfLocalD1Path(): string {
  const files = readdirSync(CF_LOCAL_D1_DIR).filter(
    (f) => f.endsWith('.sqlite') && f !== 'metadata.sqlite'
  );
  const sole = files[0];
  if (!sole) {
    throw new Error(
      `[e2e] No D1 sqlite found in ${CF_LOCAL_D1_DIR} — run 'bun test:e2e:setup:cf' first.`
    );
  }
  return join(CF_LOCAL_D1_DIR, sole);
}

export default async function globalSetup() {
  const fullPipeline = process.env.PLAYWRIGHT_FULL_PIPELINE === 'true';

  if (fullPipeline) {
    console.log('[e2e] Migrating wrangler-local D1 emulator...');
    execFileSync('bun', ['--bun', 'scripts/cf-local-migrate.ts'], {
      stdio: 'inherit',
    });

    console.log('[e2e] Seeding wrangler-local D1 emulator...');
    execFileSync('bun', ['--bun', 'scripts/seed.ts', '--cf-local'], {
      stdio: 'inherit',
    });

    if (!existsSync(CF_LOCAL_D1_DIR)) {
      throw new Error(`[e2e] Expected ${CF_LOCAL_D1_DIR} after migrate+seed`);
    }
    process.env.E2E_DB_PATH = resolveCfLocalD1Path();
    console.log(
      `[e2e] Fixtures will use E2E_DB_PATH=${process.env.E2E_DB_PATH}`
    );
  } else {
    console.log('[e2e] Migrating test database...');
    execFileSync(
      'bun',
      ['--bun', 'drizzle-kit', 'migrate', '--config=drizzle.config.test.ts'],
      { stdio: 'inherit' }
    );

    console.log('[e2e] Seeding test database...');
    execFileSync('bun', ['--bun', 'scripts/seed.ts', '--test'], {
      stdio: 'inherit',
    });
  }

  // Pre-seed the shared auth fixture user BEFORE the webServer boots so
  // miniflare's first D1 read includes the row. Without this, the worker
  // can cache a "no user" view of the sqlite file and the auth.setup.ts
  // /verify navigation aborts with ERR_ABORTED. Same effect under Nitro
  // (hermetic mode) just by being deterministic — keeps both paths uniform.
  //
  // Dynamic import: db-client.ts reads E2E_DB_PATH at module-load time, so
  // we must wait until E2E_DB_PATH has been set above before importing the
  // fixture module.
  console.log('[e2e] Pre-seeding auth fixture user...');
  const { createTestUser } = await import('./fixtures/auth.fixture');
  const user = await createTestUser({ name: 'E2E Shared User' });
  const authDir = join(import.meta.dirname, '.auth');
  if (!existsSync(authDir)) mkdirSync(authDir, { recursive: true });
  writeFileSync(join(authDir, 'user-info.json'), JSON.stringify(user, null, 2));
  console.log(`[e2e] Auth fixture user ready (id=${user.id})`);

  await startAimockServer();
}
