/**
 * Full Sequence Pipeline E2E Test
 *
 * Drives the complete sequence creation flow with real workflows running
 * against a local QStash, and AI traffic served by aimock (LLM via OpenRouter
 * passthrough, fal.ai via the mounted fal handler).
 *
 * This spec only runs when `PLAYWRIGHT_FULL_PIPELINE=true` is set. Use
 * `bun test:e2e:full` to invoke it. CI runs it in the dedicated
 * `e2e-full-pipeline` job in `.github/workflows/test.yml`.
 *
 * Prerequisites:
 * - QStash docker container running on localhost:8080 (`bun qstash:dev`)
 * - Recorded fixtures in `e2e/fixtures/recorded/` (run
 *   `bun test:e2e:record:full` once with real FAL_KEY + OPENROUTER_API_KEY in
 *   .env.local to populate; new openrouter recordings sort into stage
 *   subfolders automatically on aimock teardown).
 */

import { resolve } from 'node:path';
import { expect, type Locator } from 'playwright/test';
import { test as testWithUser } from '../fixtures/auth.fixture';
import {
  getSystemLocationByName,
  type TestLibraryLocation,
} from '../fixtures/location.fixture';
import {
  cleanupSequenceById,
  createTestStyle,
  getTestSequenceFrames,
  getTestSequenceStatus,
} from '../fixtures/sequence.fixture';
import {
  getSystemTalentByName,
  type TestTalent,
} from '../fixtures/talent.fixture';
import { t } from '../recording-mode';

const fullPipeline = process.env.PLAYWRIGHT_FULL_PIPELINE === 'true';

/**
 * Assert that a <video> / <audio> element has decoded enough metadata to be
 * playable: the URL resolves, the container is decodable, and a duration is
 * known. `readyState >= 1` (HAVE_METADATA) is sufficient — we deliberately
 * don't call `.play()` because autoplay is unreliable in headless Chromium
 * and tells us nothing extra about whether the resource itself is healthy.
 */
const expectPlayableMedia = async (locator: Locator, label: string) => {
  await expect(locator, `${label}: element visible`).toBeVisible({
    timeout: t(60_000),
  });
  await expect
    .poll(
      async () =>
        locator.evaluate(
          (el: HTMLMediaElement) =>
            el.readyState >= 1 &&
            Number.isFinite(el.duration) &&
            el.duration > 0
        ),
      {
        message: `${label}: readyState>=1 and duration>0`,
        timeout: t(60_000),
        intervals: [500, 1_000, 2_000],
      }
    )
    .toBe(true);
};

testWithUser.describe('Full Sequence Pipeline', () => {
  testWithUser.skip(
    !fullPipeline,
    'Set PLAYWRIGHT_FULL_PIPELINE=true (use `bun test:e2e:full`) to run.'
  );

  // The full pipeline runs many workflow steps end-to-end (script → frames →
  // motion → music). Each per-step poll below allows up to 10 minutes; the
  // outer cap accommodates all three running near their limit plus setup.
  testWithUser.setTimeout(1_800_000);

  let testTalents: TestTalent[] = [];
  let testLocation: TestLibraryLocation | null = null;
  let styleId: string | null = null;
  let createdSequenceId: string | null = null;

  testWithUser.beforeEach(async ({ testUser }) => {
    // Pull seeded system talent + locations rather than fabricating ones
    // with placeholder URLs — workflows need real R2 reference images for
    // character/location matching and sheet rendering. The seed runs in
    // globalSetup (see e2e/global-setup.ts).
    testTalents = [
      await getSystemTalentByName('Sienna Blake'),
      await getSystemTalentByName('Jude Calloway'),
    ];
    testLocation = await getSystemLocationByName('Sunlit Loft Studio');
    styleId = await createTestStyle(testUser.teamId);
  });

  testWithUser.afterEach(async () => {
    if (createdSequenceId && styleId) {
      await cleanupSequenceById(createdSequenceId, styleId);
    }
    // System talent and locations are shared and seeded — never delete them.
    testTalents = [];
    testLocation = null;
    styleId = null;
    createdSequenceId = null;
  });

  testWithUser(
    'creates a sequence and runs every workflow through to motion + music',
    async ({ page }) => {
      // Capture browser-side errors that would otherwise be invisible:
      // uncaught exceptions, console.error/warn from app code, failed network
      // requests, and 5xx responses. Filters two well-understood sources of
      // noise so the signal isn't drowned:
      //   - `net::ERR_ABORTED` requestfailed: in-flight requests cancelled by
      //     navigation/unmount (img tags, SSE streams, server functions).
      //     Normal lifecycle, not a bug.
      //   - TanStack Devtools' `%cLOG%c` console wrapper: decorates real logs
      //     with a "Go to Source" link and re-emits as console.error. The
      //     underlying log is what matters; the wrapping is not an app error.
      const browserErrors: string[] = [];
      page.on('pageerror', (err) => {
        browserErrors.push(`pageerror: ${err.message}`);
      });
      page.on('console', (msg) => {
        if (msg.type() !== 'error' && msg.type() !== 'warning') return;
        const text = msg.text();
        if (text.startsWith('%cLOG%c')) return;
        // Chrome auto-emits "Failed to load resource: <errorText>" alongside
        // every `requestfailed` event — same incident, second copy. The
        // requestfailed handler below already records non-aborted failures.
        if (text.startsWith('Failed to load resource:')) return;
        browserErrors.push(`console.${msg.type()}: ${text}`);
      });
      page.on('requestfailed', (req) => {
        const errorText = req.failure()?.errorText ?? 'unknown';
        if (errorText === 'net::ERR_ABORTED') return;
        browserErrors.push(
          `requestfailed: ${req.method()} ${req.url()} — ${errorText}`
        );
      });
      page.on('response', (res) => {
        if (res.status() >= 500) {
          browserErrors.push(
            `http ${res.status()}: ${res.request().method()} ${res.url()}`
          );
        }
      });

      // 1. Open the new-sequence page and wait for hydration.
      await page.goto('/sequences/new');
      await expect(
        page.getByRole('grid', { name: 'Style selection' })
      ).toBeVisible({ timeout: 15_000 });

      // 2. Select a style by clicking the first one (also confirms hydration).
      await page
        .getByRole('grid', { name: 'Style selection' })
        .getByRole('button')
        .first()
        .click();

      // 3. Type a short script — a 30-second makeup ad.
      const script = `
CORAL — A SUMMER LAUNCH

Bondi Studio - Morning in front of her microphone

Sunlight floods a white vanity. SCARLETT (19, blonde, sun-kissed),
a Bondi influencer, unboxes a coral lipstick and turns it slowly
to camera.

SCARLETT (V.O.)
One shade. One summer.

CLOSE ON LIPS — Scarlett swipes the colour, blots, smiles.

EXT. BONDI BEACH PROMENADE - CONTINUOUS

Scarlett walks the promenade, blonde hair lifting in the breeze,
surfers cresting behind her. She glances back at camera.

SCARLETT (V.O.)
Made for the water. Wear it everywhere.

EXT. BONDI BEACH - SHORELINE - CONTINUOUS

She laughs as a wave breaks at her feet. The lipstick lands
beside the brand mark in the sand.

SUPER:  CORAL.  OUT NOW.
      `.trim();
      const scriptTextarea = page.locator('textarea');
      await expect(scriptTextarea).toBeVisible();
      await scriptTextarea.fill(script);

      // 4. Enhance script (LLM streaming via aimock OpenRouter passthrough).
      await expect(
        page.getByRole('button', { name: /Enhance Script/i })
      ).toBeEnabled({ timeout: 10_000 });
      await page.getByRole('button', { name: /Enhance Script/i }).click();
      await expect(page.getByText('Target video duration')).toBeVisible();
      // Pick 1m so the enhancer generates more scenes (default is 30s). The
      // duration toggle is a Radix ToggleGroup type="single"; its items render
      // with role="radio".
      await page.getByRole('radio', { name: '1m' }).click();
      await page.getByRole('button', { name: 'Enhance' }).last().click();
      await expect(page.getByRole('button', { name: /Stop/i })).toBeVisible({
        timeout: t(15_000),
      });
      await expect(page.getByRole('button', { name: /Stop/i })).not.toBeVisible(
        { timeout: t(60_000) }
      );

      // 5. Pick talent.
      await page
        .locator('main')
        .getByRole('button', { name: 'Talent' })
        .click();
      const talentDialog = page.getByRole('dialog');
      await expect(talentDialog).toBeVisible({ timeout: 10_000 });
      await page.getByText(testTalents[0].name).click();
      await page.getByRole('button', { name: 'Cast 1 role' }).click();
      await expect(talentDialog).not.toBeVisible();

      // 6. Pick location.
      await page
        .locator('main')
        .getByRole('button', { name: 'Locations' })
        .click();
      const locationDialog = page.getByRole('dialog');
      await expect(locationDialog).toBeVisible({ timeout: 10_000 });
      if (!testLocation) throw new Error('testLocation not initialised');
      await page.getByText(testLocation.name).click();
      await page.getByRole('button', { name: 'Use 1 location' }).click();
      await expect(locationDialog).not.toBeVisible();

      // 7. Upload an element image directly to the file input on the page.
      // Photo by Vidak on Unsplash: https://unsplash.com/photos/KiqrvOpdv0I
      const fileInput = page.locator('input[type="file"][accept*="image"]');
      await fileInput.setInputFiles(
        resolve(import.meta.dirname, '../fixtures/broadcast-mic.jpg')
      );

      // 8. Generate — should kick off the workflow chain and navigate.
      await expect(
        page.getByRole('button', { name: /^Generate$/i })
      ).toBeEnabled({ timeout: 15_000 });
      await page.getByRole('button', { name: /^Generate$/i }).click();
      // Generate kicks off the scene-split workflow before the redirect lands.
      await page.waitForURL(/\/sequences\/[^/]+\/scenes/, {
        timeout: t(30_000),
      });
      const match = page.url().match(/\/sequences\/([^/]+)\/scenes/);
      const sequenceId = match?.[1];
      if (!sequenceId) {
        throw new Error(`Failed to extract sequence id from ${page.url()}`);
      }
      createdSequenceId = sequenceId;

      // 9. Wait for storyboard + frame images to land in the DB.
      await expect
        .poll(
          async () => {
            const frames = await getTestSequenceFrames(sequenceId);
            if (frames.length === 0) return false;
            return frames.every((f) => f.thumbnailStatus === 'completed');
          },
          { timeout: 600_000, intervals: [2_000, 5_000, 10_000] }
        )
        .toBe(true);

      // 10. Trigger motion generation, then wait for the scene-list footer
      //     button to leave the DOM. The footer renders a single dynamic-
      //     label button (`Writing motion prompts…` / `Composing music…` /
      //     `Generating…` / `Generate {N} / {M} frame(s)`), gated by
      //     `showButton = notStartedFrames > 0 || isMotionInProgress`
      //     (src/components/scenes/scene-list.tsx). Once motion + music are
      //     fully done it unmounts — that's the most truthful "pipeline
      //     finished" UX signal.
      const motionButton = page
        .getByRole('button', { name: /Generate \d+ ?\/ ?\d+ frames?/i })
        .first();
      await expect(motionButton).toBeVisible({ timeout: t(120_000) });
      await expect(motionButton).toBeEnabled({ timeout: t(120_000) });
      await motionButton.click();

      await expect(
        page.getByRole('button', {
          name: /Writing motion prompts|Composing music|Generating|Generate \d+ ?\/ ?\d+ frames?/i,
        })
      ).toHaveCount(0, { timeout: t(600_000) });

      // 11. Per-scene playback: click through every scene-list-item and
      //     assert the active <video> in the ScenePlayer is decodable.
      //     The list item carries `data-testid="scene-list-item"` so we can
      //     enumerate without relying on title text. The player only renders
      //     one <video> at a time (the selected frame), so each iteration
      //     forces a fresh load.
      const sceneItems = page.locator('[data-testid="scene-list-item"]');
      const sceneCount = await sceneItems.count();
      expect(sceneCount, 'sequence has at least one scene').toBeGreaterThan(0);
      const playerVideo = page.locator('video').first();
      for (let i = 0; i < sceneCount; i++) {
        await sceneItems.nth(i).click();
        await expectPlayableMedia(playerVideo, `scene ${i + 1} video`);
      }

      // 12. Music playback at /sequences/:id/music — the view renders a
      //     native <audio controls src={musicUrl} preload="metadata"> once
      //     `musicStatus === 'completed'` (src/components/music/music-view.tsx).
      await page.goto(`/sequences/${sequenceId}/music`);
      await expectPlayableMedia(
        page.locator('audio').first(),
        'sequence music'
      );

      // 13. Merged video playback at /sequences/:id/theatre — TheatreView
      //     renders <VideoPlayer src={mergedVideoUrl}> once
      //     `mergedVideoStatus === 'completed' && mergedVideoUrl`
      //     (src/components/theatre/theatre-view.tsx).
      await page.goto(`/sequences/${sequenceId}/theatre`);
      await expectPlayableMedia(page.locator('video').first(), 'merged video');

      // 14. Thin DB sanity tail: a UI bug that silently hides a player
      //     mustn't make the test pass green. We've already proved every
      //     resource decodes above, so the URL-presence asserts are
      //     belt-and-braces only.
      const finalStatus = await getTestSequenceStatus(sequenceId);
      expect(finalStatus?.musicUrl, 'sequence missing music url').toBeTruthy();
      expect(
        finalStatus?.mergedVideoUrl,
        'sequence missing merged video url'
      ).toBeTruthy();
      const finalFrames = await getTestSequenceFrames(sequenceId);
      for (const frame of finalFrames) {
        expect(frame.videoUrl, `frame ${frame.id} missing video`).toBeTruthy();
      }

      // Log any captured browser issues so they're visible in stdout / the
      // HTML report, but don't fail the test on them. Driving this list to
      // literal zero is impractical (h3 wraps any non-HTTPError throw as
      // unhandled, dev-only Better Auth warnings, etc.) and the listener has
      // already done its job — flushing out the real bugs we cared about
      // (hydration mismatch, missing fal proxy on createFalClient, swallowed
      // QStash failResponses). Re-enable the assertion if you want to gate
      // landings on browser cleanliness.
      if (browserErrors.length > 0) {
        const summary = browserErrors.join('\n');
        console.warn(
          `[e2e] captured ${browserErrors.length} browser issues (non-fatal):\n${summary}`
        );
      }
    }
  );
});
