#!/usr/bin/env bun
/**
 * Record fixtures for the full-sequence e2e test.
 *
 * Boots the e2e stack with FAL_RECORD=true and PLAYWRIGHT_FULL_PIPELINE=true,
 * then runs the full-sequence spec. The aimock server records OpenRouter
 * traffic and our fal-handler records fal.ai traffic. Subsequent runs without
 * these flags will replay from disk.
 *
 * Required env (in .env.local or shell):
 *   FAL_KEY        — real fal.ai API key
 *   OPENROUTER_KEY — real openrouter API key
 *
 * Run:
 *   bun scripts/record-e2e-fixtures.ts
 */

import { spawnSync } from 'node:child_process';

const required = ['FAL_KEY', 'OPENROUTER_KEY'] as const;
const missing = required.filter(
  (key) => !process.env[key] || process.env[key] === 'test-mock-key'
);
if (missing.length > 0) {
  console.error(
    `Missing real keys: ${missing.join(', ')}. Set them in .env.local before recording.`
  );
  process.exit(1);
}

// aimock can't stream while recording — it buffers each upstream response,
// which breaks the streaming RPC client mid-test. As a workaround we retry:
// each pass records the AI call that broke the previous run, and once a
// fixture exists aimock replays it as a real stream. After enough passes the
// full pipeline runs end-to-end without proxying.
const MAX_PASSES = Number(process.env.E2E_RECORD_PASSES ?? 8);

const env = {
  ...process.env,
  PLAYWRIGHT_FULL_PIPELINE: 'true',
  FAL_RECORD: 'true',
  // aimock records OpenRouter automatically when CI is unset
  CI: '',
  // Don't open the HTML report between passes — it spins up a server and
  // blocks waiting for Ctrl-C, which stalls the record loop.
  PW_TEST_HTML_REPORT_OPEN: 'never',
};

for (let pass = 1; pass <= MAX_PASSES; pass++) {
  console.log(`\n=== record pass ${pass}/${MAX_PASSES} ===\n`);
  const result = spawnSync('bun', ['test:e2e:full'], { stdio: 'inherit', env });
  if (result.status === 0) {
    console.log('\nfull-sequence spec passed — fixtures complete.');
    process.exit(0);
  }
}

console.error(
  `\nfull-sequence spec still failing after ${MAX_PASSES} passes. Inspect the latest run output and recorded fixtures in e2e/fixtures/recorded/.`
);
process.exit(1);
