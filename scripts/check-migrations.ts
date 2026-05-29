#!/usr/bin/env bun
/**
 * Migration safety check.
 *
 * Flags destructive SQL in drizzle migrations. The standard SQLite
 * "table rebuild" pattern (DROP X -> INSERT SELECT -> RENAME __new_X) is
 * structurally unsafe on Cloudflare D1 and Turso libSQL because their HTTP
 * /query endpoints wrap multi-statement bodies in an implicit transaction,
 * inside which `PRAGMA foreign_keys=OFF` is silently ignored — so any
 * inbound `ON DELETE CASCADE` fires when the parent table is dropped.
 *
 * See GitHub issue #612 for the verified mechanism and the production
 * incident on 2026-04-29.
 *
 * Modes:
 *   bun scripts/check-migrations.ts file1.sql file2.sql ...
 *     Scan the given files (used by lefthook with {staged_files}).
 *
 *   bun scripts/check-migrations.ts
 *     Scan all migrations not yet recorded in the local journal.
 *
 *   bun scripts/check-migrations.ts --all
 *     Scan every migration on disk.
 *
 *   bun scripts/check-migrations.ts --allow-destructive
 *     Bypass the failure exit code (escape hatch for local dev).
 *
 * Exit codes:
 *   0 — no findings
 *   1 — findings found and not bypassed
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, isAbsolute, join } from 'path';

const REPO_ROOT = join(import.meta.dirname, '..');
const MIGRATIONS_DIR = join(REPO_ROOT, 'drizzle/migrations');
const JOURNAL_PATH = join(MIGRATIONS_DIR, 'meta/_journal.json');
const SCHEMA_DIR = join(REPO_ROOT, 'src/lib/db/schema');

type DestructiveOperation = {
  file: string;
  line: number;
  operation: string;
  statement: string;
  table: string;
  cascadeChildCount: number;
};

type Journal = {
  entries: Array<{ idx: number; tag: string }>;
};

const DESTRUCTIVE_PATTERNS = [
  {
    pattern: /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?`?([^`\s;]+)`?/gi,
    name: 'DROP TABLE',
  },
  {
    pattern: /TRUNCATE\s+(?:TABLE\s+)?`?([^`\s;]+)`?/gi,
    name: 'TRUNCATE',
  },
  {
    pattern: /DELETE\s+FROM\s+`?([^`\s;]+)`?\s*(?:;|$)/gi,
    name: 'DELETE ALL',
  },
  {
    pattern: /ALTER\s+TABLE\s+`?([^`\s;]+)`?\s+DROP\s+COLUMN/gi,
    name: 'DROP COLUMN',
  },
] as const;

function getAppliedMigrations(): Set<string> {
  if (!existsSync(JOURNAL_PATH)) return new Set();
  const journal: Journal = JSON.parse(readFileSync(JOURNAL_PATH, 'utf-8'));
  return new Set(journal.entries.map((e) => `${e.tag}.sql`));
}

/**
 * Build a map of parent table -> number of inbound CASCADE FKs by scanning
 * the Drizzle schema. Used to annotate DROP TABLE findings with the
 * blast-radius count. Best-effort regex parser: an unusual definition style
 * just won't contribute, which only loses precision — every DROP TABLE is
 * still flagged.
 */
function buildCascadeMap(): Map<string, number> {
  const cascadesByParent = new Map<string, number>();
  if (!existsSync(SCHEMA_DIR)) return cascadesByParent;

  const files = readdirSync(SCHEMA_DIR).filter((f) => f.endsWith('.ts'));
  const varToTable = new Map<string, string>();

  for (const f of files) {
    const content = readFileSync(join(SCHEMA_DIR, f), 'utf-8');
    const re =
      /export\s+const\s+(\w+)\s*=\s*sqliteTable\s*\(\s*['"]([^'"]+)['"]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const varName = m[1];
      const tableName = m[2];
      if (!varName || !tableName) continue;
      varToTable.set(varName, tableName);
    }
  }

  for (const f of files) {
    const content = readFileSync(join(SCHEMA_DIR, f), 'utf-8');
    const re =
      /references\s*\(\s*\(\s*\)\s*=>\s*(\w+)\.\w+\s*,\s*\{[^}]*onDelete\s*:\s*['"]cascade['"]/gs;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const varName = m[1];
      if (!varName) continue;
      const parentTable = varToTable.get(varName);
      if (!parentTable) continue;
      cascadesByParent.set(
        parentTable,
        (cascadesByParent.get(parentTable) ?? 0) + 1
      );
    }
  }

  return cascadesByParent;
}

function findDestructiveOperations(
  filePath: string,
  cascadesByParent: Map<string, number>
): DestructiveOperation[] {
  const content = readFileSync(filePath, 'utf-8');
  const fileName = basename(filePath);
  const lines = content.split('\n');
  const operations: DestructiveOperation[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    for (const { pattern, name } of DESTRUCTIVE_PATTERNS) {
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(line)) !== null) {
        const rawTable = match[1];
        if (!rawTable) continue;
        const table = rawTable.replace(/[`"[\]]/g, '');
        // __new_X are intra-migration scratch tables, not real concerns.
        if (table.startsWith('__new_')) continue;
        operations.push({
          file: fileName,
          line: i + 1,
          operation: name,
          statement: line.trim().slice(0, 120),
          table,
          cascadeChildCount: cascadesByParent.get(table) ?? 0,
        });
      }
    }
  }

  return operations;
}

function listSqlFiles(all: boolean): string[] {
  if (!existsSync(MIGRATIONS_DIR)) return [];
  const top = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
  const fromDirs: string[] = [];
  for (const entry of readdirSync(MIGRATIONS_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const inner = join(MIGRATIONS_DIR, entry.name, 'migration.sql');
    if (existsSync(inner)) fromDirs.push(`${entry.name}/migration.sql`);
  }
  const all_ = [...top, ...fromDirs];
  if (all) return all_.map((f) => join(MIGRATIONS_DIR, f));
  const applied = getAppliedMigrations();
  if (applied.size === 0) return all_.map((f) => join(MIGRATIONS_DIR, f));
  return all_
    .filter((f) => !applied.has(f) && !applied.has(f.split('/').pop() ?? f))
    .map((f) => join(MIGRATIONS_DIR, f));
}

function main(): void {
  const args = process.argv.slice(2);
  const allowDestructive = args.includes('--allow-destructive');
  const checkAll = args.includes('--all');
  const positional = args.filter((a) => !a.startsWith('--'));

  const cascadesByParent = buildCascadeMap();

  const targets =
    positional.length > 0
      ? positional.map((p) => (isAbsolute(p) ? p : join(process.cwd(), p)))
      : listSqlFiles(checkAll);

  const allOps: Array<DestructiveOperation & { migrationDir: string }> = [];
  for (const filePath of targets) {
    if (!existsSync(filePath)) continue;
    const afterMigrations = filePath.split('/drizzle/migrations/')[1];
    const firstSegment = afterMigrations?.split('/')[0];
    const dir = firstSegment ? firstSegment.replace(/\.sql$/, '') : 'unknown';
    for (const op of findDestructiveOperations(filePath, cascadesByParent)) {
      allOps.push({ ...op, migrationDir: dir });
    }
  }

  if (allOps.length === 0) {
    console.log('No destructive operations detected.');
    process.exit(0);
  }

  console.log('Destructive operations detected:\n');
  for (const op of allOps) {
    const cascade =
      op.operation === 'DROP TABLE' && op.cascadeChildCount > 0
        ? ` ⚠ ${op.cascadeChildCount} cascade child FK(s)`
        : '';
    console.log(
      `  ${op.migrationDir}/${op.file}:${op.line} — ${op.operation} \`${op.table}\`${cascade}`
    );
    console.log(`    ${op.statement}`);
  }
  console.log('');
  console.log(
    'These are unsafe on D1/Turso HTTP migrators (issue #612). Either:'
  );
  console.log('  1. Refactor the schema change to use ALTER TABLE column ops,');
  console.log('  2. Apply manually via `wrangler d1` after a snapshot,');
  console.log('  3. Or pass --allow-destructive if data loss is intentional.');

  if (allowDestructive) {
    console.log('\n--allow-destructive set; proceeding.');
    process.exit(0);
  }
  process.exit(1);
}

main();
