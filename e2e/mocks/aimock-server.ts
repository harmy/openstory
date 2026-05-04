/**
 * aimock Server for E2E Tests
 *
 * Provides a standalone OpenAI-compatible mock server that intercepts
 * server-side LLM calls (OpenRouter) during E2E tests.
 *
 * Browser-side mocks (fal.ai, R2, QStash) remain in handlers.ts via Playwright routes.
 */

import { LLMock, loadFixturesFromDir, type Fixture } from '@copilotkit/aimock';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFalHandler } from './fal-handler';

const AIMOCK_PORT = 4010;
const FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures/recorded');

// OpenRouter SDK validates `system_fingerprint` as `z.nullable(z.string())`,
// rejecting `undefined`. aimock omits the field unless the fixture supplies
// `systemFingerprint`, so stamp a value on every text/tool-call response.
const AIMOCK_SYSTEM_FINGERPRINT = 'fp_aimock';

function stampOne(fixture: Fixture): void {
  const response = fixture.response;
  // Only completion responses (TextResponse / ToolCallResponse /
  // ContentWithToolCallsResponse) extend ResponseOverrides where
  // systemFingerprint lives. Narrow via `in` so other variants
  // (ImageResponse, ErrorResponse, …) are skipped.
  if (!('content' in response) && !('toolCalls' in response)) return;
  if (response.systemFingerprint === undefined) {
    response.systemFingerprint = AIMOCK_SYSTEM_FINGERPRINT;
  }
}

function stampSystemFingerprint(fixtures: Fixture[]): Fixture[] {
  for (const fixture of fixtures) stampOne(fixture);
  return fixtures;
}

// The recorder pushes newly-recorded fixtures straight onto LLMock's internal
// array. Wrap `push`/`unshift` so subsequent replays (e.g. workflow retries)
// also see the stamped `systemFingerprint`.
function patchFixturesArray(fixtures: Fixture[]): void {
  const originalPush = fixtures.push.bind(fixtures);
  fixtures.push = (...items: Fixture[]) => {
    for (const item of items) stampOne(item);
    return originalPush(...items);
  };
  const originalUnshift = fixtures.unshift.bind(fixtures);
  fixtures.unshift = (...items: Fixture[]) => {
    for (const item of items) stampOne(item);
    return originalUnshift(...items);
  };
}

let mockServer: LLMock | null = null;

export async function startAimockServer(): Promise<string> {
  mockServer = new LLMock({
    port: AIMOCK_PORT,
    strict: true,
    logLevel: 'info',
    // Record locally (real key from .env.local), replay-only on CI (dummy key)
    ...(!process.env.CI && {
      record: {
        providers: { openai: 'https://openrouter.ai/api/v1' },
        fixturePath: FIXTURE_DIR,
      },
    }),
  });

  // Load any previously recorded fixtures
  if (existsSync(FIXTURE_DIR)) {
    mockServer.addFixtures(
      stampSystemFingerprint(loadFixturesFromDir(FIXTURE_DIR))
    );
  }

  // Stamp fixtures the recorder appends mid-run too. getFixtures() returns
  // the internal array typed as `readonly` for callers; we monkey-patch its
  // push/unshift, which is exactly what the readonly modifier exists to
  // prevent — hence the cast.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- intentional readonly→mutable widening to install push/unshift hooks
  patchFixturesArray(mockServer.getFixtures() as Fixture[]);

  // Mount fal.ai handler at /fal so workflows can hit fal endpoints via
  // FAL_PROXY_URL=http://localhost:4010/fal. The handler manages its own
  // record/replay (aimock's record providers don't speak fal).
  mockServer.mount('/fal', createFalHandler());

  const url = await mockServer.start();
  console.log(`[e2e] aimock server started at ${url}`);
  return url;
}

export async function stopAimockServer(): Promise<void> {
  if (!mockServer) return;
  try {
    await mockServer.stop();
    console.log('[e2e] aimock server stopped');
  } catch {
    // Server may not have started successfully — ignore stop errors
  }
  mockServer = null;
}
