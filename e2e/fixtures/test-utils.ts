/**
 * Shared test utilities for E2E tests
 * Contains common patterns for page loading and cleanup operations
 */

import type { Page } from 'playwright/test';
import { expect } from 'playwright/test';
import { eq, and } from 'drizzle-orm';
import { testDb } from './db-client';
import { locationLibrary, talent } from '@/lib/db/schema';

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
  const [created] = await testDb
    .select({ id: locationLibrary.id })
    .from(locationLibrary)
    .where(
      and(eq(locationLibrary.teamId, teamId), eq(locationLibrary.name, name))
    );
  await testDb
    .delete(locationLibrary)
    .where(eq(locationLibrary.id, created.id));
}

/**
 * Find and cleanup a talent created during a test by name.
 * Use for tests that create entities via UI and need inline cleanup.
 */
export async function cleanupTalentByName(
  teamId: string,
  name: string
): Promise<void> {
  const [created] = await testDb
    .select({ id: talent.id })
    .from(talent)
    .where(and(eq(talent.teamId, teamId), eq(talent.name, name)));
  await testDb.delete(talent).where(eq(talent.id, created.id));
}
