/**
 * Enhance Script E2E Tests
 *
 * Tests the enhance script flow using aimock for server-side LLM mocking.
 * aimock intercepts OpenRouter calls so the streaming enhance response
 * comes from the mock server instead of a real LLM.
 */

import { expect } from 'playwright/test';
import { test as testWithUser } from '../fixtures/auth.fixture';
import { setupMockRoutes } from '../mocks/handlers';

testWithUser.describe('Enhance Script Flow', () => {
  testWithUser.beforeEach(async ({ page }) => {
    await setupMockRoutes(page);
  });

  testWithUser('can enhance script and generate sequence', async ({ page }) => {
    // Navigate to new sequence page
    await page.goto('/sequences/new');

    // Wait for React hydration — style grid requires query data
    await expect(
      page.getByRole('grid', { name: 'Style selection' })
    ).toBeVisible({ timeout: 15000 });

    // Select a style (click first one to ensure hydration)
    const firstStyle = page
      .getByRole('grid', { name: 'Style selection' })
      .getByRole('button')
      .first();
    await firstStyle.click();

    // Enter a short script
    const scriptTextarea = page.locator('textarea');
    await expect(scriptTextarea).toBeVisible();
    await scriptTextarea.fill(
      'A developer in a coffee shop tries to fix a bug before an important demo.'
    );

    // Wait for "Enhance Script" button to be enabled
    const enhanceButton = page.getByRole('button', {
      name: /Enhance Script/i,
    });
    await expect(enhanceButton).toBeEnabled({ timeout: 5000 });

    // Click "Enhance Script" to open duration popover
    await enhanceButton.click();

    // Verify popover with duration presets appears
    await expect(page.getByText('Target video duration')).toBeVisible();

    // 30s is already selected by default — click "Enhance" in popover
    await page.getByRole('button', { name: 'Enhance' }).last().click();

    // Verify streaming indicator appears (Stop button)
    await expect(page.getByRole('button', { name: /Stop/i })).toBeVisible({
      timeout: 10000,
    });

    // Wait for streaming to complete — Stop button disappears
    await expect(page.getByRole('button', { name: /Stop/i })).not.toBeVisible({
      timeout: 30000,
    });

    // Verify enhanced content appeared in textarea — should be longer and different
    const enhancedContent = await scriptTextarea.inputValue();
    expect(enhancedContent.length).toBeGreaterThan(100);

    // Verify "Undo" button appeared
    await expect(page.getByRole('button', { name: /Undo/i })).toBeVisible();

    // Verify "Generate" is enabled
    const generateButton = page.getByRole('button', {
      name: /^Generate$/i,
    });
    await expect(generateButton).toBeEnabled({ timeout: 10000 });

    // Click "Generate"
    await generateButton.click();

    // Verify navigation to sequence scenes page
    await page.waitForURL(/\/sequences\/[^/]+\/scenes/, {
      timeout: 30000,
    });
  });

  testWithUser('can undo enhanced script', async ({ page }) => {
    await page.goto('/sequences/new');

    // Wait for hydration
    await expect(
      page.getByRole('grid', { name: 'Style selection' })
    ).toBeVisible({ timeout: 15000 });

    // Select style
    await page
      .getByRole('grid', { name: 'Style selection' })
      .getByRole('button')
      .first()
      .click();

    // Enter original script
    const scriptTextarea = page.locator('textarea');
    const originalScript =
      'A detective investigates a mysterious disappearance in a small coastal town.';
    await scriptTextarea.fill(originalScript);

    // Open enhance popover and click enhance
    await page.getByRole('button', { name: /Enhance Script/i }).click();
    await expect(page.getByText('Target video duration')).toBeVisible();
    await page.getByRole('button', { name: 'Enhance' }).last().click();

    // Wait for streaming to complete
    await expect(page.getByRole('button', { name: /Stop/i })).toBeVisible({
      timeout: 10000,
    });
    await expect(page.getByRole('button', { name: /Stop/i })).not.toBeVisible({
      timeout: 30000,
    });

    // Verify content changed
    const enhancedContent = await scriptTextarea.inputValue();
    expect(enhancedContent).not.toBe(originalScript);
    expect(enhancedContent.length).toBeGreaterThan(originalScript.length);

    // Click Undo
    await page.getByRole('button', { name: /Undo/i }).click();

    // Verify original script restored
    const restoredContent = await scriptTextarea.inputValue();
    expect(restoredContent).toBe(originalScript);
  });
});
