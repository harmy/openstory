/**
 * Seed `styles.sampleVideos` (issue #718).
 *
 * One-off seeder: for every built-in style template it derives the canonical
 * (and, for hero styles, bespoke) R2 URLs, verifies each one is actually
 * reachable, then writes the validated `StyleSampleVideo[]` onto the matching
 * system-team `styles` row.
 *
 * No fallbacks: if ANY expected URL is missing/unreachable the script lists
 * them and aborts WITHOUT touching the database. Run the render + upload first.
 *
 * Usage:
 *   bun scripts/seed-style-sample-videos.ts --local            # local D1
 *   bun scripts/seed-style-sample-videos.ts --test             # [env.test] D1
 *   bun scripts/seed-style-sample-videos.ts --d1               # prod D1 (HTTP)
 *   bun scripts/seed-style-sample-videos.ts --local --dry-run  # validate only
 */
import { styles, teams } from '@/lib/db/schema';
import type { StyleSampleVideo } from '@/lib/db/schema/libraries';
import { buildSampleVideos } from '@/lib/style/sample-videos';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import { eq } from 'drizzle-orm';
import {
  createSeedDb,
  parseSeedTarget,
  type SeedTarget,
} from './seed-db-client';

const SYSTEM_TEAM_SLUG = 'system-templates';
const VALIDATION_CONCURRENCY = 10;

function getPublicAssetsDomain(): string {
  const domain = process.env.VITE_R2_PUBLIC_ASSETS_DOMAIN;
  if (!domain) {
    throw new Error(
      'VITE_R2_PUBLIC_ASSETS_DOMAIN is required to build sample-video URLs'
    );
  }
  return domain;
}

/** A reachable URL responds 200/206 to a 1-byte ranged GET. */
async function isUrlReachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { headers: { Range: 'bytes=0-0' } });
    return res.ok; // 200 or 206
  } catch {
    return false;
  }
}

async function validateAll(urls: string[]): Promise<string[]> {
  const missing: string[] = [];
  for (let i = 0; i < urls.length; i += VALIDATION_CONCURRENCY) {
    const batch = urls.slice(i, i + VALIDATION_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (url) => ({ url, ok: await isUrlReachable(url) }))
    );
    for (const { url, ok } of results) {
      process.stdout.write(ok ? '.' : 'x');
      if (!ok) missing.push(url);
    }
  }
  process.stdout.write('\n');
  return missing;
}

async function run(target: SeedTarget, dryRun: boolean) {
  const domain = getPublicAssetsDomain();

  // 1. Build the intended entries for every template.
  const planned = DEFAULT_STYLE_TEMPLATES.map((style) => ({
    name: style.name,
    entries: buildSampleVideos({ domain, styleName: style.name }),
  }));

  const allUrls = planned.flatMap((p) => p.entries.map((e) => e.url));
  console.log(
    `Validating ${allUrls.length} URLs across ${planned.length} styles…`
  );

  // 2. Validate reachability — abort loudly on any miss.
  const missing = await validateAll(allUrls);
  if (missing.length > 0) {
    console.error(`\n❌ ${missing.length} sample video URL(s) unreachable:`);
    for (const url of missing) console.error(`   - ${url}`);
    console.error(
      '\nRun generate-style-sample-videos.ts + upload-style-sample-videos-to-r2.ts first. Aborting; no DB writes.'
    );
    process.exit(1);
  }
  console.log('✅ All sample video URLs reachable.\n');

  if (dryRun) {
    const heroCount = planned.filter((p) => p.entries.length > 1).length;
    console.log(
      `Dry run — would update ${planned.length} styles (${heroCount} with bespoke). No DB writes.`
    );
    return;
  }

  // 3. Write to DB.
  const { db, dispose } = await createSeedDb(target);
  try {
    const [systemTeam]: { id: string }[] = await db
      .select()
      .from(teams)
      .where(eq(teams.slug, SYSTEM_TEAM_SLUG));
    if (!systemTeam) {
      throw new Error(
        `System team '${SYSTEM_TEAM_SLUG}' not found — run db:seed first.`
      );
    }

    const existing = await db
      .select()
      .from(styles)
      .where(eq(styles.teamId, systemTeam.id));
    const existingByName = new Map(existing.map((s) => [s.name, s]));

    let updated = 0;
    const notFound: string[] = [];
    for (const { name, entries } of planned) {
      const row = existingByName.get(name);
      if (!row) {
        notFound.push(name);
        continue;
      }
      await db
        .update(styles)
        .set({
          sampleVideos: entries satisfies StyleSampleVideo[],
          updatedAt: new Date(),
        })
        .where(eq(styles.id, row.id));
      updated++;
    }

    console.log(`✅ Updated sampleVideos on ${updated} style(s).`);
    if (notFound.length > 0) {
      console.error(
        `❌ ${notFound.length} template(s) had no matching DB row (run db:seed):`
      );
      for (const name of notFound) console.error(`   - ${name}`);
      process.exit(1);
    }
  } finally {
    await dispose();
  }
}

const target = parseSeedTarget(process.argv.slice(2));
const dryRun = process.argv.includes('--dry-run');
await run(target, dryRun);
