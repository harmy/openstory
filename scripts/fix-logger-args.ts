#!/usr/bin/env bun
/**
 * Fix-up script: after `migrate-console-to-logtape.ts`, wrap loose positional
 * args in `logger.{info,warn,error,debug}(...)` calls so they satisfy LogTape's
 * overloads.
 *
 * Cases handled:
 *   - logger.error('msg', err)                       -> logger.error('msg', { err })
 *   - logger.error('msg', 'msg2', err)               -> logger.error('msg msg2', { err })
 *   - logger.error(`tpl ${x}`, err)                  -> logger.error(`tpl ${x}`, { err })
 *   - logger.warn('msg', someObject)                 -> logger.warn('msg', { data: someObject })
 *     when someObject is NOT already a `{...}` literal
 *   - logger.warn('msg', 'msg2')                     -> logger.warn('msg msg2')
 *
 * Strategy: parse with the TypeScript compiler API (already a project dep via
 * tsgo), walk for CallExpression nodes matching `logger.<method>(...)`, and
 * rewrite via offset patches applied in reverse order so earlier offsets
 * remain valid.
 *
 * Also drops `import { getLogger }` + `const logger = getLogger(...)` from
 * files where the migration script inserted an unused logger (the console
 * matches were inside JSDoc comments).
 */

import { glob, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

const SKIP_FILE_RE =
  /(\.test\.ts|\.spec\.ts|\.stories\.tsx|\.gen\.ts|\/lib\/observability\/logger\.ts|\/lib\/mocks\/)/;

const LOGGER_METHODS = new Set(['info', 'warn', 'error', 'debug']);

type Patch = { start: number; end: number; replacement: string };

/**
 * Best-effort heuristic: does this expression look like a plain object literal
 * we can safely pass as LogTape's `properties` arg without wrapping?
 */
function isObjectLiteralLike(node: ts.Expression): boolean {
  if (ts.isObjectLiteralExpression(node)) return true;
  // Allow `() => ({ ... })` and `(): X => ({ ... })` (LogTape supports lazy props)
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  return false;
}

/**
 * Should the value safely fit LogTape's Error overload?
 */
function isErrorTypeReference(
  node: ts.Expression,
  sourceFile: ts.SourceFile
): boolean {
  // Heuristic only — we don't have type info from tsgo here. We just check
  // common patterns where the value is already known-Error: `new Error(...)`.
  if (ts.isNewExpression(node)) {
    const ctorText = node.expression.getText(sourceFile);
    return ctorText.endsWith('Error');
  }
  return false;
}

function visitCallExpressions(
  sourceFile: ts.SourceFile,
  visit: (call: ts.CallExpression) => void
): void {
  function walk(node: ts.Node): void {
    if (ts.isCallExpression(node)) visit(node);
    ts.forEachChild(node, walk);
  }
  walk(sourceFile);
}

function isLoggerMethodCall(
  call: ts.CallExpression
): { method: string } | null {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr)) return null;
  if (!ts.isIdentifier(expr.expression)) return null;
  // Match `logger.X(...)` and `fnLogger.X(...)` and any `*Logger.X(...)`
  const objName = expr.expression.text;
  if (!/logger$/i.test(objName)) return null;
  const method = expr.name.text;
  if (!LOGGER_METHODS.has(method)) return null;
  return { method };
}

function buildFixedCall(
  call: ts.CallExpression,
  sourceFile: ts.SourceFile,
  source: string
): Patch | null {
  const args = call.arguments;
  if (args.length < 2) return null;

  const first = args[0];
  if (!first) return null;

  // Skip tagged-template-style calls (those aren't CallExpressions anyway)
  // Skip already-correct calls (second arg is an object literal or arrow)
  const second = args[1];
  if (!second) return null;
  if (isObjectLiteralLike(second) && args.length === 2) return null;

  // Case A: 3 args, last is an identifier-ish error and middle is a string.
  //   logger.X('a', 'b', err) -> logger.X('a b', { err })
  if (args.length === 3) {
    const third = args[2];
    if (!third) return null;

    const firstIsString =
      ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first);
    const secondIsString =
      ts.isStringLiteral(second) || ts.isNoSubstitutionTemplateLiteral(second);

    if (firstIsString && secondIsString && !isObjectLiteralLike(third)) {
      const merged =
        `${first.text}${first.text.endsWith(' ') ? '' : ' '}${second.text}`.trim();
      const wrappedThird = wrapForLogger(third, sourceFile, source);
      const replacement = `${call.expression.getText(sourceFile)}('${escapeSingle(merged)}', ${wrappedThird})`;
      return {
        start: call.getStart(sourceFile),
        end: call.getEnd(),
        replacement,
      };
    }

    // Fallthrough: leave 3-arg calls alone if we can't merge cleanly
    return null;
  }

  // Case B: 2 args, second is not an object literal.
  //   logger.X('msg', err) -> logger.X('msg', { err })
  if (args.length === 2) {
    if (isObjectLiteralLike(second)) return null;
    if (isErrorTypeReference(second, sourceFile)) return null; // matches Error overload

    const firstText = first.getText(sourceFile);
    const wrapped = wrapForLogger(second, sourceFile, source);
    const replacement = `${call.expression.getText(sourceFile)}(${firstText}, ${wrapped})`;
    return {
      start: call.getStart(sourceFile),
      end: call.getEnd(),
      replacement,
    };
  }

  return null;
}

function wrapForLogger(
  expr: ts.Expression,
  sourceFile: ts.SourceFile,
  _source: string
): string {
  const text = expr.getText(sourceFile);
  // If the expression is a bare identifier we want `{ name }` shorthand;
  // otherwise wrap as `{ err: <text> }` or `{ data: <text> }` depending on
  // identifier hint.
  if (ts.isIdentifier(expr)) {
    const name = expr.text;
    if (
      name === 'err' ||
      name === 'error' ||
      name === 'e' ||
      name.endsWith('Err') ||
      name.endsWith('Error')
    ) {
      return name === 'err' ? `{ err }` : `{ err: ${name} }`;
    }
    return `{ ${name} }`;
  }
  // For property accesses like `result.foo`, member expressions, etc.
  return `{ data: ${text} }`;
}

function escapeSingle(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * Remove unused `import { getLogger }` + `const logger = getLogger(...)` from
 * a file when the only logger references are inside comments.
 */
function maybeStripUnusedLogger(source: string): string | null {
  const usesLoggerInCode = hasLoggerUsageOutsideComments(source);
  if (usesLoggerInCode) return null;

  let next = source;
  next = next.replace(
    /\n?import\s+\{\s*getLogger\s*\}\s+from\s+['"]@\/lib\/observability\/logger['"];?\s*\n?/,
    '\n'
  );
  next = next.replace(
    /\n?const\s+logger\s*=\s*getLogger\(\[[^\]]*\]\);?\s*\n?/,
    '\n'
  );
  return next === source ? null : next;
}

function hasLoggerUsageOutsideComments(source: string): boolean {
  // Strip comments then look for `logger.<method>(`
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\s)\/\/.*$/gm, '');
  return /\blogger\.(?:info|warn|error|debug|with|getChild)\b/.test(stripped);
}

async function processFile(filePath: string): Promise<{
  patched: number;
  strippedUnused: boolean;
}> {
  let source = await readFile(filePath, 'utf8');

  const stripped = maybeStripUnusedLogger(source);
  if (stripped !== null) {
    await writeFile(filePath, stripped, 'utf8');
    return { patched: 0, strippedUnused: true };
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.ESNext,
    true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );

  const patches: Patch[] = [];

  visitCallExpressions(sourceFile, (call) => {
    if (!isLoggerMethodCall(call)) return;
    const patch = buildFixedCall(call, sourceFile, source);
    if (patch) patches.push(patch);
  });

  if (patches.length === 0) return { patched: 0, strippedUnused: false };

  // Apply patches in reverse so offsets stay valid.
  patches.sort((a, b) => b.start - a.start);
  for (const p of patches) {
    source = source.slice(0, p.start) + p.replacement + source.slice(p.end);
  }

  await writeFile(filePath, source, 'utf8');
  return { patched: patches.length, strippedUnused: false };
}

async function main(): Promise<void> {
  let totalFiles = 0;
  let totalPatches = 0;
  let totalStripped = 0;

  for await (const filePath of glob('**/*.{ts,tsx}', { cwd: SRC })) {
    const absPath = path.isAbsolute(filePath)
      ? filePath
      : path.join(SRC, filePath);
    if (SKIP_FILE_RE.test(absPath)) continue;

    const { patched, strippedUnused } = await processFile(absPath);
    if (patched === 0 && !strippedUnused) continue;

    totalFiles += 1;
    totalPatches += patched;
    if (strippedUnused) totalStripped += 1;

    const tag = strippedUnused ? ' (-unused logger)' : '';
    process.stdout.write(
      `${path.relative(ROOT, absPath)}: ${patched} patch${patched === 1 ? '' : 'es'}${tag}\n`
    );
  }

  process.stdout.write(
    `\nPatched ${totalPatches} call${totalPatches === 1 ? '' : 's'} across ${totalFiles} file${totalFiles === 1 ? '' : 's'} (stripped unused logger from ${totalStripped} file${totalStripped === 1 ? '' : 's'}).\n`
  );
}

await main();
