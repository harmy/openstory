#!/usr/bin/env bun
/**
 * Upload style sample videos to the R2 public bucket (issue #718).
 *
 * Scans `sample-videos/{slug}/` produced by generate-style-sample-videos.ts and
 * uploads each `canonical.mp4` / `bespoke.mp4` to
 * `styles/{slug}/{canonical|bespoke}.mp4` in the public assets bucket — the same
 * wrangler-CLI path used by upload-style-previews-to-r2.ts.
 *
 * Usage:
 *   bun scripts/upload-style-sample-videos-to-r2.ts            # upload all found
 *   bun scripts/upload-style-sample-videos-to-r2.ts --dry-run  # list keys only
 *   bun scripts/upload-style-sample-videos-to-r2.ts --filter product-ad
 */
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SAMPLE_DIR = path.join(process.cwd(), 'sample-videos');
const KINDS = ['canonical', 'bespoke'] as const;

const isDryRun = process.argv.includes('--dry-run');
const filterIdx = process.argv.findIndex((a) => a === '--filter');
const filter = filterIdx >= 0 ? process.argv[filterIdx + 1] : undefined;

const R2_CONFIG = {
  bucket: process.env.R2_PUBLIC_ASSETS_BUCKET || 'openstory-public-assets',
  url: `https://${process.env.VITE_R2_PUBLIC_ASSETS_DOMAIN || 'assets.openstory.so'}`,
};

type Upload = { localPath: string; r2Key: string };

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function collectUploads(): Promise<Upload[]> {
  if (!(await exists(SAMPLE_DIR))) {
    console.error(
      `Directory not found: ${SAMPLE_DIR}. Run generate-style-sample-videos.ts first.`
    );
    process.exit(1);
  }
  const slugs = (await readdir(SAMPLE_DIR, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((slug) => !filter || slug === filter);

  const uploads: Upload[] = [];
  for (const slug of slugs) {
    for (const kind of KINDS) {
      const localPath = path.join(SAMPLE_DIR, slug, `${kind}.mp4`);
      if (await exists(localPath)) {
        uploads.push({ localPath, r2Key: `styles/${slug}/${kind}.mp4` });
      }
    }
  }
  return uploads;
}

async function uploadToR2(localPath: string, r2Key: string): Promise<void> {
  const fullKey = `${R2_CONFIG.bucket}/${r2Key}`;
  try {
    await execFileAsync('bunx', [
      'wrangler',
      'r2',
      'object',
      'put',
      fullKey,
      `--file=${localPath}`,
      '--remote',
    ]);
  } catch (error) {
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String(error.stderr).trim()
        : '';
    throw new Error(
      `Failed to upload ${r2Key}: ${stderr || (error instanceof Error ? error.message : String(error))}`
    );
  }
}

async function main() {
  const uploads = await collectUploads();
  if (uploads.length === 0) {
    console.log('No sample videos found to upload.');
    return;
  }

  console.log(`Found ${uploads.length} video(s) → ${R2_CONFIG.bucket}`);
  if (isDryRun) {
    for (const u of uploads) console.log(`  ${R2_CONFIG.url}/${u.r2Key}`);
    console.log('\nDry run — no uploads. Run without --dry-run to upload.');
    return;
  }

  let success = 0;
  const failures: string[] = [];
  for (const u of uploads) {
    try {
      await uploadToR2(u.localPath, u.r2Key);
      success++;
      console.log(`  ✅ ${u.r2Key}`);
    } catch (error) {
      failures.push(u.r2Key);
      console.error(
        `  ❌ ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  console.log(`\nUploaded ${success}/${uploads.length}.`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
