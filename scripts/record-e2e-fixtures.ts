#!/usr/bin/env bun
/**
 * Record fixtures for the full-sequence e2e test.
 *
 * Boots the e2e stack with FAL_RECORD=true and PLAYWRIGHT_FULL_PIPELINE=true,
 * then runs the full-sequence spec. The aimock server records OpenRouter
 * traffic and our fal-handler records fal.ai traffic. Subsequent runs without
 * these flags will replay from disk.
 *
 * After the run, OpenRouter fixtures land in `recorded/openrouter/_unsorted/`
 * (aimock's recorder writes flat). We sort them into stage subfolders
 * (script-enhance, visual-prompts, motion-prompts, …) by inspecting each
 * fixture's `userMessage` prefix. fal fixtures route into per-service
 * subfolders directly via `fal-handler.ts:serviceSlug`, so they need no
 * post-processing.
 *
 * Required env (in .env.local or shell):
 *   FAL_KEY        — real fal.ai API key
 *   OPENROUTER_KEY — real openrouter API key
 *
 * Run:
 *   bun scripts/record-e2e-fixtures.ts
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
} from 'node:fs';
import { resolve } from 'node:path';

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

const env = {
  ...process.env,
  PLAYWRIGHT_FULL_PIPELINE: 'true',
  FAL_RECORD: 'true',
  // aimock records OpenRouter automatically when CI is unset
  CI: '',
  // Don't open the HTML report — it spins up a server and blocks on Ctrl-C.
  PW_TEST_HTML_REPORT_OPEN: 'never',
};

const result = spawnSync('bun', ['test:e2e:full'], { stdio: 'inherit', env });

sortOpenRouterFixtures();

process.exit(result.status ?? 1);

// Maps a fixture's `userMessage` prefix to the stage subfolder it belongs in.
// First-match-wins; order doesn't matter as long as prefixes are disjoint
// (they are — each comes from a distinct workflow step's prompt template).
const STAGE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['Please enhance this script for a short film', 'script-enhance'],
  ['Analyze the script within the USER_SCRIPT', 'script-analyze'],
  ['Match the following library locations', 'location-match'],
  ['Cast the following talent', 'talent-cast'],
  ['Generate the visual prompt for the starting frame', 'visual-prompts'],
  ['Generate the motion prompt for this scene', 'motion-prompts'],
  ['Classify music design for each scene', 'music-design'],
];

type FixtureFile = {
  fixtures: Array<{ match: { userMessage?: string } }>;
};

function classifyStage(filePath: string): string | null {
  const data: FixtureFile = JSON.parse(readFileSync(filePath, 'utf8'));
  const userMessage = data.fixtures[0]?.match.userMessage ?? '';
  return (
    STAGE_PREFIXES.find(([prefix]) => userMessage.startsWith(prefix))?.[1] ??
    null
  );
}

function sortOpenRouterFixtures(): void {
  const stagingDir = resolve(
    import.meta.dirname,
    '../e2e/fixtures/recorded/openrouter/_unsorted'
  );
  const targetRoot = resolve(stagingDir, '..');
  if (!existsSync(stagingDir)) return;

  const files = readdirSync(stagingDir).filter((name) =>
    name.endsWith('.json')
  );
  if (files.length === 0) {
    rmdirSync(stagingDir);
    return;
  }

  console.log(`\n[record] sorting ${files.length} new openrouter fixture(s)…`);
  let sorted = 0;
  for (const name of files) {
    const src = resolve(stagingDir, name);
    const stage = classifyStage(src);
    if (stage === null) {
      console.warn(
        `[record] WARN: ${name} has no matching stage prefix — leaving in _unsorted/. Add it to STAGE_PREFIXES if it's a new prompt family.`
      );
      continue;
    }
    const stageDir = resolve(targetRoot, stage);
    mkdirSync(stageDir, { recursive: true });
    renameSync(src, resolve(stageDir, name));
    sorted++;
  }
  console.log(`[record] sorted ${sorted}/${files.length} fixtures`);

  const remaining = readdirSync(stagingDir);
  if (remaining.length === 0) rmdirSync(stagingDir);
}
