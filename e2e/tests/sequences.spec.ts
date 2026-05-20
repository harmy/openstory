/**
 * Sequences E2E Tests
 * Tests sequence creation and viewing flows
 */

import { test, expect } from 'playwright/test';

test.describe('Sequences', () => {
  test('can access sequences list page', async ({ page }) => {
    await page.goto('/sequences');

    await expect(page).toHaveURL(/\/sequences/);
  });

  test('can access new sequence page', async ({ page }) => {
    await page.goto('/sequences/new');

    await expect(page).toHaveURL('/sequences/new');
  });

  test('new sequence page has script input', async ({ page }) => {
    await page.goto('/sequences/new');

    // The script field is a TipTap-backed contenteditable wrapped in the
    // MarkdownEditor component. Target it by data-slot so the assertion is
    // resilient to internal ProseMirror DOM shape.
    const editor = page.locator('[data-slot="markdown-editor"]');
    await expect(editor).toBeVisible();
  });
});
