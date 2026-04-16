/**
 * aimock Server for E2E Tests
 *
 * Provides a standalone OpenAI-compatible mock server that intercepts
 * server-side LLM calls (OpenRouter) during E2E tests.
 *
 * Browser-side mocks (fal.ai, R2, QStash) remain in handlers.ts via Playwright routes.
 */

import { LLMock, loadFixturesFromDir } from '@copilotkit/aimock';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const AIMOCK_PORT = 4010;
const FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures/recorded');

let mockServer: LLMock | null = null;

export async function startAimockServer(): Promise<string> {
  mockServer = new LLMock({
    port: AIMOCK_PORT,
    strict: true,
    logLevel: 'info',
    record: {
      providers: { openai: 'https://openrouter.ai/api/v1' },
      fixturePath: FIXTURE_DIR,
    },
  });

  // Load any previously recorded fixtures
  if (existsSync(FIXTURE_DIR)) {
    mockServer.addFixtures(loadFixturesFromDir(FIXTURE_DIR));
  }

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
