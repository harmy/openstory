import { execFileSync } from 'node:child_process';
import { startAimockServer } from './mocks/aimock-server';
import { startR2MockServer } from './mocks/r2-mock-server';

/**
 * Playwright global setup - migrates + seeds the local Wrangler D1 (test env),
 * then starts aimock (LLM/fal on :4010) and r2-mock (R2 fixtures on :4011).
 */
export default async function globalSetup() {
  console.log('[e2e] Migrating test D1 (Wrangler local, [env.test])...');
  // Drizzle migrations live as nested <timestamp>_<name>/migration.sql which
  // wrangler's flat-file migrator can't handle. scripts/migrate-local-d1.ts
  // uses drizzle-orm/d1/migrator against the same Miniflare D1 binding.
  execFileSync('bun', ['scripts/migrate-local-d1.ts', '--test'], {
    stdio: 'inherit',
  });

  console.log('[e2e] Seeding test database...');
  execFileSync('bun', ['scripts/seed.ts', '--test'], {
    stdio: 'inherit',
  });

  await startAimockServer();
  await startR2MockServer();
}
