/**
 * Copy local Wrangler D1 state between the main repo and a worktree.
 *
 *   bun scripts/db-worktree.ts --fork      # main repo  → current worktree
 *   bun scripts/db-worktree.ts --promote   # current worktree → main repo
 *
 * Wired up as `bun db:fork:local` and `bun db:promote:local`.
 *
 * Use --fork right after `git worktree add` so the new worktree starts with the
 * same D1 schema + data as your main checkout (no re-migrate, no re-seed). Use
 * --promote when you've built up useful state inside a worktree and want it to
 * become the "primary" local D1 for future worktrees to fork from.
 *
 * Only D1 is copied — R2 is `remote: true` in wrangler.jsonc so local R2 state
 * is unused. KV/cache/workflows aren't copied; they're either regenerated on
 * demand or stateless.
 */

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const STATE_SUBDIR = '.wrangler/state/v3/d1';

const mode = process.argv[2];
if (mode !== '--fork' && mode !== '--promote') {
  console.error('Usage: bun scripts/db-worktree.ts --fork | --promote');
  process.exit(1);
}

const gitCommonDir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
  encoding: 'utf-8',
}).trim();
const mainRepoRoot = path.dirname(path.resolve(gitCommonDir));
const here = process.cwd();

if (mainRepoRoot === here) {
  console.error(
    `[db-worktree] already in the main repo (${mainRepoRoot}). ${mode} only makes sense from a worktree.`
  );
  process.exit(1);
}

const [src, dest, label] =
  mode === '--promote'
    ? [
        path.join(here, STATE_SUBDIR),
        path.join(mainRepoRoot, STATE_SUBDIR),
        'promoted',
      ]
    : [
        path.join(mainRepoRoot, STATE_SUBDIR),
        path.join(here, STATE_SUBDIR),
        'forked',
      ];

if (!existsSync(src)) {
  console.error(
    `[db-worktree] no D1 state at ${src}. ${mode === '--fork' ? 'Bootstrap the main repo first with bun db:migrate:local + bun db:seed:local.' : 'Run bun db:migrate:local + bun db:seed:local in this worktree first.'}`
  );
  process.exit(1);
}

rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.log(`[db-worktree] ${label} D1 state: ${src} → ${dest}`);
