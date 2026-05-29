#!/usr/bin/env bun
/**
 * Migration script: rewrite raw console.* calls in src/ to LogTape getLogger calls.
 *
 * Mechanical transforms only:
 *   - Adds `import { getLogger } from '@/lib/observability/logger';` if missing.
 *   - Adds `const logger = getLogger([...]);` after imports if missing.
 *     Category derived from the file path (e.g. lib/workflows/foo-workflow.ts ->
 *     ['openstory','workflow','foo-workflow']).
 *   - Replaces console.{log,info,warn,error,debug}( -> logger.{info,info,warn,error,debug}(
 *
 * Does NOT attempt to fix argument shape (e.g. `console.error('x', err)` will become
 * `logger.error('x', err)` which may fail to typecheck when err is `unknown`). Run
 * `bun typecheck` after and fix call-site issues manually.
 *
 * Skips:
 *   - src/lib/observability/logger.ts (the sink itself)
 *   - *.test.ts, *.spec.ts, *.stories.tsx, *.gen.ts
 *   - src/lib/mocks/** (mock helpers; tests-only)
 */

import { glob, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

const SKIP_FILE_RE =
  /(\.test\.ts|\.spec\.ts|\.stories\.tsx|\.gen\.ts|\/lib\/observability\/logger\.ts|\/lib\/mocks\/)/;

/**
 * Map file path -> LogTape category array.
 *
 *   src/lib/workflows/foo-workflow.ts  -> ['openstory', 'workflow', 'foo']
 *   src/lib/ai/llm-client.ts           -> ['openstory', 'ai', 'llm-client']
 *   src/lib/services/email-service.ts  -> ['openstory', 'services', 'email-service']
 *   src/functions/frames.ts            -> ['openstory', 'serverFn', 'frames']
 *   src/routes/api/billing/webhook.ts  -> ['openstory', 'api', 'billing', 'webhook']
 *   src/hooks/use-foo.ts               -> ['openstory', 'ui', 'use-foo']
 *   src/components/auth/auth-form.tsx  -> ['openstory', 'ui', 'auth', 'auth-form']
 */
function categoryFor(filePath: string): string[] {
  const rel = path.relative(SRC, filePath).replace(/\\/g, '/');
  const noExt = rel.replace(/\.(tsx|ts)$/, '');
  const parts = noExt.split('/');

  // Strip the trailing "-workflow" suffix from workflow files for brevity.
  const last = parts.at(-1) ?? '';
  const trimmedLast =
    parts[0] === 'lib' && parts[1] === 'workflows'
      ? last.replace(/-workflow$/, '')
      : last;

  if (parts[0] === 'lib' && parts[1] === 'workflows') {
    return ['openstory', 'workflow', trimmedLast];
  }
  if (parts[0] === 'lib' && parts[1] === 'workflow') {
    return ['openstory', 'workflow', trimmedLast];
  }
  if (parts[0] === 'lib' && parts[1] === 'ai') {
    return ['openstory', 'ai', trimmedLast];
  }
  if (parts[0] === 'lib') {
    return ['openstory', parts[1] ?? 'lib', trimmedLast];
  }
  if (parts[0] === 'functions') {
    return ['openstory', 'serverFn', trimmedLast];
  }
  if (parts[0] === 'routes' && parts[1] === 'api') {
    return ['openstory', 'api', ...parts.slice(2, -1), trimmedLast];
  }
  if (parts[0] === 'hooks') {
    return ['openstory', 'ui', trimmedLast];
  }
  if (parts[0] === 'components') {
    return ['openstory', 'ui', ...parts.slice(1, -1), trimmedLast];
  }
  return ['openstory', ...parts];
}

const CONSOLE_METHOD_MAP: Record<string, string> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
  debug: 'debug',
};

const CONSOLE_CALL_RE = /\bconsole\.(log|info|warn|error|debug)\b/g;

function hasLoggerImport(source: string): boolean {
  return /from\s+['"]@\/lib\/observability\/logger['"]/.test(source);
}

function hasLoggerDecl(source: string): boolean {
  return /\bconst\s+logger\s*=\s*getLogger\(/.test(source);
}

/**
 * Find a good insertion point for the import + logger declaration: after the
 * last `import ... from '...'` statement.
 */
function findImportInsertionPoint(source: string): number {
  const importRe = /^import\s.+from\s+['"][^'"]+['"];?\s*$/gm;
  let lastEnd = 0;
  for (const match of source.matchAll(importRe)) {
    if (match.index === undefined) continue;
    lastEnd = match.index + match[0].length;
  }
  return lastEnd;
}

function buildHeader(category: string[]): string {
  const arr = category.map((c) => `'${c}'`).join(', ');
  return `\nimport { getLogger } from '@/lib/observability/logger';\n\nconst logger = getLogger([${arr}]);\n`;
}

function rewriteConsoleCalls(source: string): {
  next: string;
  rewrites: number;
} {
  let count = 0;
  const next = source.replace(CONSOLE_CALL_RE, (_match, method: string) => {
    count++;
    const mapped = CONSOLE_METHOD_MAP[method] ?? 'info';
    return `logger.${mapped}`;
  });
  return { next, rewrites: count };
}

async function migrate(filePath: string): Promise<{
  rewrites: number;
  added: boolean;
} | null> {
  const source = await readFile(filePath, 'utf8');
  if (!CONSOLE_CALL_RE.test(source)) return null;
  // Reset RegExp.lastIndex from the .test() above
  CONSOLE_CALL_RE.lastIndex = 0;

  const { next: rewritten, rewrites } = rewriteConsoleCalls(source);
  if (rewrites === 0) return null;

  let result = rewritten;
  let added = false;
  if (!hasLoggerImport(result) || !hasLoggerDecl(result)) {
    const insertAt = findImportInsertionPoint(result);
    const header = buildHeader(categoryFor(filePath));
    result = result.slice(0, insertAt) + header + result.slice(insertAt);
    added = true;
  }

  await writeFile(filePath, result, 'utf8');
  return { rewrites, added };
}

async function main(): Promise<void> {
  let totalFiles = 0;
  let totalRewrites = 0;
  let totalHeadersAdded = 0;

  for await (const entry of glob('**/*.{ts,tsx}', { cwd: SRC })) {
    const filePath = path.isAbsolute(entry) ? entry : path.join(SRC, entry);
    if (SKIP_FILE_RE.test(filePath)) continue;

    const result = await migrate(filePath);
    if (!result) continue;

    totalFiles += 1;
    totalRewrites += result.rewrites;
    if (result.added) totalHeadersAdded += 1;
    process.stdout.write(
      `${path.relative(ROOT, filePath)}: ${result.rewrites} call${result.rewrites === 1 ? '' : 's'}${result.added ? ' (+import)' : ''}\n`
    );
  }

  process.stdout.write(
    `\nMigrated ${totalRewrites} call${totalRewrites === 1 ? '' : 's'} across ${totalFiles} file${totalFiles === 1 ? '' : 's'} (${totalHeadersAdded} header${totalHeadersAdded === 1 ? '' : 's'} inserted).\n`
  );
}

await main();
