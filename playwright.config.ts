import { defineConfig, devices } from 'playwright/test';

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

  // Global test timeout (longer on CI due to slower 2-vCPU runners)
  timeout: process.env.CI ? 60_000 : 30_000,

  // Shared settings for all projects
  use: {
    baseURL: 'http://localhost:3001',
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
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
      use: { ...devices['Desktop Chrome'] },
    },
    // All other tests - use stored auth state
    {
      name: 'chromium',
      testIgnore: /auth\.spec\.ts/,
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/user.json',
      },
      dependencies: ['setup'],
    },
  ],

  webServer: (() => {
    const useBuiltServer = process.env.E2E_BUILT === 'true';
    const fullPipeline = process.env.PLAYWRIGHT_FULL_PIPELINE === 'true';
    const envPrefix = [
      'E2E_TEST=true',
      ...(fullPipeline
        ? ['E2E_FULL_PIPELINE=true', 'FAL_PROXY_URL=http://localhost:4010/fal']
        : []),
      'PORT=3001',
      'DATABASE_URL=file:test.db',
      'VITE_APP_URL=http://localhost:3001',
      'OPENROUTER_BASE_URL=http://localhost:4010',
      'VITE_DISABLE_DEVTOOLS=true',
    ].join(' ');

    // E2E_FULL_PIPELINE opts the server into running real workflows + routing
    // fal traffic through the aimock fal handler. Off by default so existing
    // hermetic specs keep using browser-side route mocks. Set
    // PLAYWRIGHT_FULL_PIPELINE=true (e.g. for the full-sequence spec) to flip.
    //
    // E2E_BUILT=true runs the production-built Nitro server (`bun start`)
    // instead of `vite dev` — used on CI to avoid HMR/dev-only behaviour and
    // to catch bundling/Nitro-runtime issues earlier. Local dev keeps the
    // dev-server path for fast iteration.
    return {
      command: useBuiltServer
        ? `${envPrefix} bun start`
        : `${envPrefix} bun dev:e2e`,
      url: 'http://localhost:3001',
      reuseExistingServer: !useBuiltServer,
      timeout: 300_000,
      stdout: 'pipe',
      stderr: 'pipe',
    };
  })(),
});
