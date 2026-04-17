/**
 * Sequence Creation Flow E2E Tests
 *
 * Tests the complete flow:
 * 1. Create sequence with suggested talent
 * 2. Generate and select variants
 * 3. Recast character with different talent
 */

import { expect } from 'playwright/test';
import { test as testWithUser } from '../fixtures/auth.fixture';
import { setupMockRoutes } from '../mocks/handlers';
import {
  createTestTalentSet,
  cleanupTalentById,
  type TestTalent,
} from '../fixtures/talent.fixture';
import {
  createTestSequence,
  createTestFrame,
  createTestCharacter,
  cleanupSequenceById,
  getTestFrame,
  getTestCharacter,
  type TestSequence,
  type TestFrame,
  type TestCharacter,
} from '../fixtures/sequence.fixture';

// Each test creates its own data with unique names for parallel execution
testWithUser.describe('Sequence Creation Flow', () => {
  let testTalents: TestTalent[] = [];

  testWithUser.beforeEach(async ({ page, testUser }) => {
    // Setup mock routes for AI/workflow calls
    await setupMockRoutes(page);

    // Create test talent for the test user's team with unique names
    const suffix = crypto.randomUUID().slice(0, 8);
    testTalents = await createTestTalentSet(testUser.teamId, [
      `E2E Test Actor One ${suffix}`,
      `E2E Test Actor Two ${suffix}`,
    ]);
  });

  testWithUser.afterEach(async () => {
    // Cleanup test data - only the specific talents we created
    for (const t of testTalents) {
      await cleanupTalentById(t.id);
    }
    testTalents = [];
  });

  testWithUser(
    'can create sequence with suggested talent',
    async ({ page }) => {
      // Navigate to new sequence page
      await page.goto('/sequences/new');

      // Wait for React hydration + data loading by checking the style grid is populated
      // The style grid requires useStyles() query data, which only loads after hydration
      await expect(
        page.getByRole('grid', { name: 'Style selection' })
      ).toBeVisible({ timeout: 15000 });

      const scriptTextarea = page.locator('textarea');
      await expect(scriptTextarea).toBeVisible();
      await expect(page).toHaveURL('/sequences/new');

      // Enter a simple test script
      const testScript = `
INT. COFFEE SHOP - DAY

JOHN, a 30-something developer, sits at a table with his laptop.

JOHN
I need to fix this bug before the demo.

SARAH, his colleague, approaches with two coffees.

SARAH
Here's your caffeine fix. How's it going?
    `.trim();

      // Click a style to force React interaction and confirm hydration
      // The style grid may be SSR-rendered before React hydrates
      const firstStyle = page
        .getByRole('grid', { name: 'Style selection' })
        .getByRole('button')
        .first();
      await firstStyle.click();

      // Now fill the textarea - React is hydrated since style click worked
      await scriptTextarea.fill(testScript);

      // Wait for "Generate" button to become enabled - this proves:
      // 1. React hydration is complete (event handlers attached)
      // 2. Textarea fill was picked up by React state (script is set)
      // 3. Style was selected (from our click above)
      await expect(page.getByRole('button', { name: /Generate/i })).toBeEnabled(
        { timeout: 10000 }
      );

      // Open talent suggestion dialog
      const talentButton = page
        .locator('main')
        .getByRole('button', { name: 'Talent' });
      await talentButton.click();

      // Wait for talent dialog to open - the dialog is rendered via a portal
      // Use a longer timeout as it may need to fetch talent data
      const talentDialog = page.getByRole('dialog');
      await expect(talentDialog).toBeVisible({ timeout: 10000 });
      await expect(
        talentDialog.getByText('Select Talent for Casting')
      ).toBeVisible();

      // Verify our test talents appear in the dialog (use variable names)
      await expect(page.getByText(testTalents[0].name)).toBeVisible();
      await expect(page.getByText(testTalents[1].name)).toBeVisible();

      // Select first talent by clicking on it
      await page.getByText(testTalents[0].name).click();

      // Close dialog
      await page.getByRole('button', { name: 'Done' }).click();
      await expect(talentDialog).not.toBeVisible();

      // Verify submit button is ready (may have different text based on state)
      const submitButton = page.getByRole('button', {
        name: /Generate/i,
      });
      await expect(submitButton).toBeVisible();
    }
  );
});

// Each test creates its own data with unique names for parallel execution
testWithUser.describe('Variant Selection', () => {
  let testSequence: TestSequence;
  let testFrame: TestFrame;
  const originalThumbnailUrl =
    'http://localhost:3001/api/test/image?w=1024&h=576&label=thumb';

  testWithUser.beforeEach(async ({ page, testUser }) => {
    await setupMockRoutes(page);

    // Create pre-seeded sequence with frame that has variant image (unique name)
    testSequence = await createTestSequence(
      testUser.teamId,
      testUser.id,
      `E2E Variant Test Sequence ${crypto.randomUUID().slice(0, 8)}`
    );
    testFrame = await createTestFrame(testSequence.id, 0, {
      // Use real placeholder images
      thumbnailUrl: originalThumbnailUrl,
      variantImageUrl:
        'http://localhost:3001/api/test/image?w=3072&h=3072&label=variants',
      variantImageStatus: 'completed',
    });
  });

  testWithUser.afterEach(async () => {
    await cleanupSequenceById(testSequence.id, testSequence.styleId);
  });

  testWithUser('can select variant from grid', async ({ page }) => {
    // Verify initial state in database
    const frameBefore = await getTestFrame(testFrame.id);
    expect(frameBefore?.thumbnailUrl).toBe(originalThumbnailUrl);

    // Navigate directly to the sequence scenes page
    await page.goto(`/sequences/${testSequence.id}/scenes`);

    // Don't use networkidle - the page has a realtime SSE connection that never settles
    // Wait for the sequence title to be visible (indicates data has loaded and React is hydrated)
    await expect(
      page.getByRole('heading', { name: testSequence.title })
    ).toBeVisible({ timeout: 15000 });

    // Also wait for the frame thumbnail to be visible
    // Frames load via a separate API call from the sequence data, so needs its own timeout
    await expect(page.getByRole('img', { name: 'Scene 1' })).toBeVisible({
      timeout: 15000,
    });

    const variantsTab = page.getByRole('tab', { name: /Variants/i });
    await expect(variantsTab).toBeVisible({ timeout: 10000 });

    // Click the Variants tab
    await variantsTab.click();

    const variantGrid = page.getByRole('grid', { name: 'Variant selection' });

    // Wait for variant grid to be visible
    await expect(variantGrid).toBeVisible({ timeout: 10000 });

    // Click on variant 5 (center tile)
    const variant5 = page.getByRole('button', { name: 'Select variant 5' });
    await expect(variant5).toBeVisible();
    await variant5.click();

    // Confirmation dialog should appear
    await expect(page.getByText('Select this variant?')).toBeVisible();

    // Confirm selection
    await page.getByRole('button', { name: 'Confirm' }).click();

    // Dialog should close
    await expect(page.getByText('Select this variant?')).not.toBeVisible();

    // Wait for the API call to complete and verify database was updated
    // The thumbnailUrl should have changed from the original
    await expect
      .poll(
        async () => {
          const frameAfter = await getTestFrame(testFrame.id);
          return frameAfter?.thumbnailUrl;
        },
        { timeout: 20_000 }
      )
      .not.toBe(originalThumbnailUrl);
  });
});

// Each test creates its own data with unique names for parallel execution
testWithUser.describe('Character Recast', () => {
  let testTalents: TestTalent[] = [];
  let testSequence: TestSequence;
  let testCharacter: TestCharacter;

  testWithUser.beforeEach(async ({ page, testUser }) => {
    await setupMockRoutes(page);

    // Create test talent with unique names
    const suffix = crypto.randomUUID().slice(0, 8);
    testTalents = await createTestTalentSet(testUser.teamId, [
      `E2E Current Actor ${suffix}`,
      `E2E New Actor ${suffix}`,
    ]);

    // Create pre-seeded sequence with character (unique name)
    testSequence = await createTestSequence(
      testUser.teamId,
      testUser.id,
      `E2E Recast Test Sequence ${suffix}`
    );

    // Create a character linked to the first talent
    testCharacter = await createTestCharacter(
      testSequence.id,
      'char_001',
      'John',
      testTalents[0].id,
      {
        // Use real placeholder image
        sheetImageUrl:
          'http://localhost:3001/api/test/image?w=1920&h=1080&label=character',
        sheetStatus: 'completed',
      }
    );
  });

  testWithUser.afterEach(async () => {
    // Cleanup specific entities we created
    for (const t of testTalents) {
      await cleanupTalentById(t.id);
    }
    await cleanupSequenceById(testSequence.id, testSequence.styleId);
    testTalents = [];
  });

  testWithUser(
    'can recast character with different talent',
    async ({ page }) => {
      // Verify initial state - character is linked to first talent
      const characterBefore = await getTestCharacter(testCharacter.id);
      expect(characterBefore?.talentId).toBe(testTalents[0].id);

      // Navigate to the character detail page
      await page.goto(`/sequences/${testSequence.id}/cast/${testCharacter.id}`);

      // Wait for character detail to load
      await page.waitForLoadState('domcontentloaded');
      await expect(page.locator('h1').filter({ hasText: 'John' })).toBeVisible({
        timeout: 15000,
      });

      // Click Recast button
      const recastButton = page.getByRole('button', { name: 'Recast' });
      await expect(recastButton).toBeVisible();
      await recastButton.click();

      // Talent picker dialog should open
      const talentDialog = page.getByRole('dialog');
      await expect(talentDialog).toBeVisible();
      await expect(talentDialog.getByText('Select Talent')).toBeVisible();

      // Select the second talent (use variable name)
      await page.getByText(testTalents[1].name).click();

      // Recast confirmation dialog should appear (use regex with variable)
      await expect(
        page.getByText(new RegExp(`Recast ${testTalents[1].name} as John`, 'i'))
      ).toBeVisible();

      // Confirm the recast
      await page.getByRole('button', { name: 'Recast' }).click();

      // The confirmation dialog should close (loading state may briefly appear)
      // With mocks, the mutation should complete quickly
      await expect(
        page.getByText(new RegExp(`Recast ${testTalents[1].name} as John`, 'i'))
      ).not.toBeVisible({ timeout: 10000 });

      // Verify the database was updated - character now linked to second talent
      await expect
        .poll(
          async () => {
            const characterAfter = await getTestCharacter(testCharacter.id);
            return characterAfter?.talentId;
          },
          { timeout: 20_000 }
        )
        .toBe(testTalents[1].id);
    }
  );
});

// Skip empty state test in parallel mode - it interferes with other tests
// by cleaning up all talent for the shared team. This test works in serial mode.
// TODO: Consider running this test with a dedicated user/team for isolation
testWithUser.describe.skip('Empty States', () => {
  testWithUser(
    'shows empty state when no talent in library',
    async ({ page }) => {
      await setupMockRoutes(page);

      await page.goto('/sequences/new');

      // Wait for React hydration + data loading
      await expect(
        page.getByRole('grid', { name: 'Style selection' })
      ).toBeVisible({ timeout: 15000 });

      // Open talent dialog - find button in main content area
      const talentButton = page
        .locator('main')
        .getByRole('button', { name: 'Talent' });
      await expect(talentButton).toBeVisible();
      await talentButton.click();

      // Wait for dialog to open
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible({ timeout: 10000 });

      // Verify empty state
      await expect(page.getByText('No talent in library')).toBeVisible();
    }
  );
});
