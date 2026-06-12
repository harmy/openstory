/**
 * Import remotely-hosted storage objects into local Miniflare R2.
 *
 * Since #771, local dev serves storage from the local R2 binding via the
 * worker's /r2/$ route. Existing checkouts (and DBs forked from dev/prod)
 * still have rows whose URLs point at the remote public CDN
 * (storage-dev.openstory.so / storage.openstory.so). Those objects are all
 * publicly readable, so this script:
 *
 *   1. scans every text column of every table in the local D1 for URLs on
 *      the source domain(s) — including JSON columns like frame.metadata,
 *   2. downloads each referenced object from the public CDN (no credentials
 *      needed) and puts it into the local R2 binding under the same key,
 *   3. rewrites the DB URLs in place to the origin-relative `/r2/<key>` form
 *      (#894) so the /r2 serve route picks them up.
 *
 * Usage:
 *   bun scripts/import-remote-r2.ts               # copy + rewrite (default env)
 *   bun scripts/import-remote-r2.ts --dry-run     # report what would happen
 *   bun scripts/import-remote-r2.ts --no-rewrite  # copy objects, keep CDN URLs
 *   bun scripts/import-remote-r2.ts --domain=storage.example.com  # extra source
 *
 * Idempotent: objects already present locally are skipped, and the URL
 * rewrite only touches rows still containing a source-domain URL. Run with
 * the dev server stopped (same contract as scripts/db-worktree.ts).
 */

import { getLocalPlatformProxy } from './local-platform-proxy';

const SOURCE_DOMAINS = [
  'storage-dev.openstory.so',
  'storage.openstory.so',
  'storage-stg.openstory.so',
];

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const rewrite = !args.includes('--no-rewrite');
for (const arg of args) {
  const domain = /^--domain=(.+)$/.exec(arg)?.[1];
  if (domain) SOURCE_DOMAINS.push(domain);
}

const DOWNLOAD_CONCURRENCY = 8;

// Escape ALL regex metacharacters — domains can arrive via --domain=, and a
// stray `(`/`*` would otherwise change the pattern's meaning (CodeQL
// js/regex-injection).
function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Matches a full storage URL on any source domain. Key charset is
// conservative (our keys are bucket/ULID/slug paths) and stops at JSON/string
// delimiters so URLs embedded in metadata JSON extract cleanly.
const urlRe = new RegExp(
  `https://(?:${SOURCE_DOMAINS.map(escapeRegex).join('|')})/[A-Za-z0-9._%/-]+`,
  'g'
);

const proxy = await getLocalPlatformProxy<{
  DB?: D1Database;
  R2_STORAGE_BUCKET?: R2Bucket;
}>();

const db = proxy.env.DB;
const r2 = proxy.env.R2_STORAGE_BUCKET;
if (!db || !r2) {
  throw new Error(
    '[import-remote-r2] DB or R2_STORAGE_BUCKET binding missing from wrangler.jsonc default env.'
  );
}

// ── 1. Discover tables + text columns ───────────────────────────────────────

type TableRow = { name: string };
const tables = (
  await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
       AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf%' AND name NOT LIKE 'd1_%'`
    )
    .all<TableRow>()
).results.map((row) => row.name);

type ColumnRow = { name: string; type: string };
const textColumns: Array<{ table: string; column: string }> = [];
for (const table of tables) {
  const cols = (
    await db.prepare(`PRAGMA table_info("${table}")`).all<ColumnRow>()
  ).results;
  for (const col of cols) {
    // SQLite types are loose; anything text-affine can hold a URL or JSON.
    if (/TEXT|CHAR|CLOB|JSON/i.test(col.type) || col.type === '') {
      textColumns.push({ table, column: col.name });
    }
  }
}

// ── 2. Collect referenced URLs ──────────────────────────────────────────────

const urls = new Set<string>();
const columnsWithMatches: Array<{ table: string; column: string }> = [];

for (const { table, column } of textColumns) {
  for (const domain of SOURCE_DOMAINS) {
    const rows = (
      await db
        .prepare(
          `SELECT DISTINCT "${column}" AS v FROM "${table}" WHERE "${column}" LIKE ?`
        )
        .bind(`%${domain}%`)
        .all<{ v: string }>()
    ).results;
    if (rows.length > 0) {
      columnsWithMatches.push({ table, column });
      for (const row of rows) {
        for (const match of row.v.matchAll(urlRe)) urls.add(match[0]);
      }
    }
  }
}

console.log(
  `[import-remote-r2] found ${urls.size} unique object URL(s) across ${columnsWithMatches.length} column(s)`
);

// ── 3. Download + put into local R2 ─────────────────────────────────────────

let copied = 0;
let skipped = 0;
let failed = 0;
let bytes = 0;

async function importOne(url: string): Promise<void> {
  const key = decodeURIComponent(new URL(url).pathname.slice(1));
  if (!key) return;

  const existing = await r2?.head(key);
  if (existing) {
    skipped++;
    return;
  }
  if (dryRun) {
    console.log(`[dry-run] would copy ${url} → ${key}`);
    copied++;
    return;
  }

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    console.warn(`[import-remote-r2] ${res.status} for ${url} — skipped`);
    failed++;
    return;
  }
  const body = await res.arrayBuffer();
  await r2?.put(key, body, {
    httpMetadata: {
      contentType:
        res.headers.get('content-type') ?? 'application/octet-stream',
      cacheControl: 'public, max-age=31536000',
    },
  });
  bytes += body.byteLength;
  copied++;
}

const queue = [...urls];
await Promise.all(
  Array.from({ length: DOWNLOAD_CONCURRENCY }, async () => {
    for (let url = queue.pop(); url !== undefined; url = queue.pop()) {
      await importOne(url);
    }
  })
);

console.log(
  `[import-remote-r2] copied ${copied}, already-local ${skipped}, failed ${failed}` +
    (bytes > 0 ? ` (${(bytes / 1024 / 1024).toFixed(1)} MB)` : '')
);

// ── 4. Rewrite DB URLs to the local /r2 form ────────────────────────────────

if (rewrite && !dryRun) {
  let rewrittenRows = 0;
  for (const { table, column } of columnsWithMatches) {
    for (const domain of SOURCE_DOMAINS) {
      const result = await db
        .prepare(
          `UPDATE "${table}" SET "${column}" = REPLACE("${column}", ?, ?) WHERE "${column}" LIKE ?`
        )
        .bind(`https://${domain}/`, '/r2/', `%${domain}%`)
        .run();
      rewrittenRows += result.meta.changes;
    }
  }
  console.log(
    `[import-remote-r2] rewrote URLs in ${rewrittenRows} row(s) to /r2/...`
  );
} else if (rewrite && dryRun) {
  console.log(
    `[import-remote-r2] [dry-run] would rewrite URLs in ${columnsWithMatches.length} column(s) to /r2/...`
  );
}

await proxy.dispose();
