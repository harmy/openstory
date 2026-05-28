import { execFileSync } from 'node:child_process';
import { startAimockServer } from './mocks/aimock-server';
import { startR2MockServer } from './mocks/r2-mock-server';

/**
 * Playwright global setup - migrates + seeds the local Wrangler D1 (test env),
 * then starts aimock (LLM/fal on :4010) and r2-mock (R2 fixtures on :4011).
 */
export default async function globalSetup() {
  console.log('[e2e] Migrating test D1 (Wrangler local, [env.test])...');
  execFileSync(
    'wrangler',
    ['d1', 'migrations', 'apply', 'DB', '--local', '--env=test'],
    { stdio: 'inherit' }
  );

  console.log('[e2e] Seeding test database...');
  execFileSync('bun', ['scripts/seed.ts', '--test'], {
    stdio: 'inherit',
  });

  await startAimockServer();
  await startR2MockServer();
}
