import { execFileSync } from 'node:child_process';
import { startAimockServer } from './mocks/aimock-server';

/**
 * Playwright global setup - ensures test.db is migrated and seeded,
 * and starts the aimock server for LLM mocking before tests run.
 */
export default async function globalSetup() {
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

  await startAimockServer();
}
