#!/usr/bin/env bun
/**
 * Strip `[Tag]` / `[Tag:foo]` prefixes from the first string arg of
 * `logger.{info,warn,error,debug}(...)` calls. The category path already
 * encodes this information, so the prefix is redundant noise.
 *
 * Conservative: only touches plain string literals and non-substitution
 * template literals (the parts before any `${...}`). Leaves complex templates
 * with the prefix intact for human review.
 *
 * Examples:
 *   logger.error('[AuthForm] Send OTP failed', { err })
 *     -> logger.error('Send OTP failed', { err })
 *   logger.warn(`[Workflow:${name}] failed`, { err })
 *     -> logger.warn(`failed`, { err })  (interpolation moved out)
 *     -> reverted to original if the interpolation occurs INSIDE the bracket
 */

import { glob, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(ROOT, 'src');

const SKIP_FILE_RE =
  /(\.test\.ts|\.spec\.ts|\.stories\.tsx|\.gen\.ts|\/lib\/observability\/logger\.ts|\/lib\/mocks\/)/;

const LOGGER_METHODS = new Set(['info', 'warn', 'error', 'debug']);
const PREFIX_RE = /^\s*\[[^\]]+\]\s*/;

type Patch = { start: number; end: number; replacement: string };

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

function isLoggerMethodCall(call: ts.CallExpression): boolean {
  const expr = call.expression;
  if (!ts.isPropertyAccessExpression(expr)) return false;
  if (!ts.isIdentifier(expr.expression)) return false;
  const objName = expr.expression.text;
  if (!/logger$/i.test(objName)) return false;
  return LOGGER_METHODS.has(expr.name.text);
}

function stripFromStringLiteral(
  node: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral
): string | null {
  const text = node.text;
  const stripped = text.replace(PREFIX_RE, '').trim();
  if (stripped === text) return null;
  if (stripped.length === 0) return null;
  // Decide quote style based on original kind
  if (ts.isStringLiteral(node)) {
    return `'${escapeSingle(stripped)}'`;
  }
  return `\`${escapeBacktick(stripped)}\``;
}

function stripFromTemplateExpression(
  node: ts.TemplateExpression
): string | null {
  const head = node.head.text;
  const stripped = head.replace(PREFIX_RE, '');
  if (stripped === head) return null;
  // Reconstruct template with stripped head + original tails
  let out = `\`${escapeBacktick(stripped)}`;
  for (const span of node.templateSpans) {
    const exprText = span.expression.getText();
    const tail =
      span.literal.kind === ts.SyntaxKind.TemplateMiddle
        ? span.literal.text
        : span.literal.text;
    out += `\${${exprText}}${escapeBacktick(tail)}`;
  }
  out += '`';
  return out;
}

function escapeSingle(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escapeBacktick(input: string): string {
  return input
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

async function processFile(filePath: string): Promise<number> {
  const source = await readFile(filePath, 'utf8');
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
    const first = call.arguments[0];
    if (!first) return;

    if (
      ts.isStringLiteral(first) ||
      ts.isNoSubstitutionTemplateLiteral(first)
    ) {
      const replacement = stripFromStringLiteral(first);
      if (replacement) {
        patches.push({
          start: first.getStart(sourceFile),
          end: first.getEnd(),
          replacement,
        });
      }
      return;
    }

    if (ts.isTemplateExpression(first)) {
      const replacement = stripFromTemplateExpression(first);
      if (replacement) {
        patches.push({
          start: first.getStart(sourceFile),
          end: first.getEnd(),
          replacement,
        });
      }
    }
  });

  if (patches.length === 0) return 0;

  let out = source;
  patches.sort((a, b) => b.start - a.start);
  for (const p of patches) {
    out = out.slice(0, p.start) + p.replacement + out.slice(p.end);
  }
  await writeFile(filePath, out, 'utf8');
  return patches.length;
}

async function main(): Promise<void> {
  let totalFiles = 0;
  let totalPatches = 0;

  for await (const entry of glob('**/*.{ts,tsx}', { cwd: SRC })) {
    const filePath = path.isAbsolute(entry) ? entry : path.join(SRC, entry);
    if (SKIP_FILE_RE.test(filePath)) continue;

    const n = await processFile(filePath);
    if (n === 0) continue;
    totalFiles += 1;
    totalPatches += n;
    process.stdout.write(`${path.relative(ROOT, filePath)}: ${n}\n`);
  }
  process.stdout.write(
    `\nStripped ${totalPatches} prefix${totalPatches === 1 ? '' : 'es'} across ${totalFiles} file${totalFiles === 1 ? '' : 's'}.\n`
  );
}

await main();
