/**
 * Shared test utilities for E2E tests
 * Contains common patterns for page loading and cleanup operations
 */

import type { Page } from 'playwright/test';
import { expect } from 'playwright/test';

/**
 * Wait for a library page to be hydrated by checking that its Add button is enabled.
 * The button is disabled during SSR/hydration via useHydrated hook.
 */
export async function waitForLibraryPageLoad(
  page: Page,
  buttonName: string
): Promise<void> {
  const addButton = page.getByRole('button', { name: buttonName }).first();
  await expect(addButton).toBeEnabled({ timeout: 30000 });
}

/**
 * Find and cleanup a location created during a test by name.
 * Use for tests that create entities via UI and need inline cleanup.
 */
export async function cleanupLocationByName(
  teamId: string,
  name: string
): Promise<void> {
  await fetch('http://localhost:3001/api/test/location', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, name }),
  });
}

/**
 * Find and cleanup a talent created during a test by name.
 * Use for tests that create entities via UI and need inline cleanup.
 */
export async function cleanupTalentByName(
  teamId: string,
  name: string
): Promise<void> {
  await fetch('http://localhost:3001/api/test/talent', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamId, name }),
  });
}
