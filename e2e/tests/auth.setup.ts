/**
 * Auth Setup — authenticates the shared E2E user in the browser and saves
 * the session storage state for the rest of the suite to reuse.
 *
 * The user itself is pre-seeded by `e2e/global-setup.ts` before the
 * webServer boots, so the workerd worker's first D1 read sees the row.
 * Inserting it here (after the worker is already running) used to race
 * with miniflare's SQLite cache and abort the /verify navigation.
 */

import fs from 'node:fs';
import path from 'node:path';
import { test as setup } from 'playwright/test';
import { authenticateUser } from '../fixtures/auth.fixture';

const authDir = path.join(import.meta.dirname, '../.auth');
const authFile = path.join(authDir, 'user.json');
const userInfoFile = path.join(authDir, 'user-info.json');

setup('authenticate', async ({ page }) => {
  if (!fs.existsSync(userInfoFile)) {
    throw new Error(
      `[auth.setup] ${userInfoFile} not found — global-setup should pre-seed the auth fixture user before this runs.`
    );
  }
  const user = JSON.parse(fs.readFileSync(userInfoFile, 'utf-8')) as {
    email: string;
  };

  await authenticateUser(page, user.email);
  await page.context().storageState({ path: authFile });
});
