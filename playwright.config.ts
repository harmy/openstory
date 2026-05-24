import { defineConfig, devices } from 'playwright/test';
import { E2E_RECORDING } from './e2e/recording-mode';

/**
 * Playwright E2E Test Configuration
 * Uses separate test.db for isolation, mocks AI/workflow responses
 */
export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  testDir: './e2e/tests',
  outputDir: './e2e/results',

  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,

  // Fail fast on CI
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,

  // Reporter configuration
  // CI: github for annotations + html for uploadable report
  // Local: html only
  reporter: process.env.CI ? [['github'], ['html']] : 'html',

  // Global test timeout. Recording mode hits live OpenRouter / fal so it needs
  // headroom; CI is slower than local; replay-only local is the fast path.
  timeout: E2E_RECORDING ? 600_000 : process.env.CI ? 60_000 : 30_000,

  // Default expect() timeout. Recording lets streaming/vision calls take their
  // time; replay keeps the snappy 5s default so flakes surface fast.
  expect: { timeout: E2E_RECORDING ? 60_000 : 5_000 },

  // Shared settings for all projects
  use: {
    baseURL: 'http://localhost:3001',
    viewport: { width: 1920, height: 1080 },
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: process.env.CI
      ? 'on-first-retry'
      : { mode: 'on', size: { width: 1920, height: 1080 } },
    // Local recordings render the app in dark mode (matches the design's
    // primary palette). CI keeps the default light scheme. The app uses
    // `@media (prefers-color-scheme: dark)` so this toggles natively
    // without injecting a class.
    colorScheme: process.env.CI ? 'light' : 'dark',
  },

  // Configure projects
  projects: [
    // Setup project - authenticates once, saves state
    {
      name: 'setup',
      testMatch: /.*\.setup\.ts/,
    },
    // Auth tests - run without stored state to test actual login flow
    {
      name: 'auth',
      testMatch: /auth\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
      },
    },
    // All other tests - use stored auth state
    {
      name: 'chromium',
      testIgnore: /auth\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1920, height: 1080 },
        storageState: 'e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],

  webServer: (() => {
    const fullPipeline = process.env.PLAYWRIGHT_FULL_PIPELINE === 'true';
    const useBuiltServer = process.env.E2E_BUILT === 'true';
    const envPrefix = [
      'E2E_TEST=true',
      ...(fullPipeline
        ? [
            'E2E_FULL_PIPELINE=true',
            'FAL_PROXY_URL=http://localhost:4010/fal',
            // Route every workflow through Cloudflare Workflows. The workerd
            // runtime supplies the bindings; resolveEngineForTrigger falls
            // back to QStash if a binding is missing, so this stays safe.
            'CF_WORKFLOWS_ENABLED=all',
          ]
        : []),
      // Propagate the record flag so the dev server's adapter factory can
      // disable the OpenRouter SDK's retry loop — see create-adapter.ts. We
      // do this only when recording because aimock buffers SSE responses
      // upstream, which can trip the SDK's retry path and produce duplicate
      // fixture writes for the same prompt.
      ...(process.env.E2E_RECORD === '1' ? ['E2E_RECORD=1'] : []),
      'PORT=3001',
      // Hermetic Nitro path reads sqlite via DATABASE_URL. CF path reads via
      // the D1 binding, but the env var is harmless there.
      'DATABASE_URL=file:test.db',
      'VITE_APP_URL=http://localhost:3001',
      'OPENROUTER_BASE_URL=http://localhost:4010',
      'VITE_DISABLE_DEVTOOLS=true',
    ].join(' ');

    // Four webServer shapes, picked by (fullPipeline, useBuiltServer):
    //   (false, false) Hermetic dev:   `bun dev:e2e`   — Vite dev, Nitro
    //   (false, true)  Hermetic built: `bun start`     — built Nitro
    //   (true, false)  CF dev:         `bun dev:e2e:cf` — Vite dev, CF plugin
    //   (true, true)   CF built:       `bun start:e2e:cf` — wrangler dev
    //                                   against the prebuilt CF artifact
    const command = fullPipeline
      ? useBuiltServer
        ? `${envPrefix} bun start:e2e:cf`
        : `${envPrefix} bun dev:e2e:cf`
      : useBuiltServer
        ? `${envPrefix} bun start`
        : `${envPrefix} bun dev:e2e`;

    return {
      command,
      // Wait for an HTTP response, not just the TCP port. wrangler dev binds
      // :3001 before the worker module has finished loading, so a port-based
      // wait races: tests fire `page.goto` against a listener that hasn't
      // wired up its handler yet and the browser sees net::ERR_ABORTED.
      // `/` is the marketing homepage — fully static, returns 200 in both
      // Nitro-built and CF-built modes.
      url: 'http://localhost:3001/',
      reuseExistingServer: !useBuiltServer && !fullPipeline,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    };
  })(),
});
