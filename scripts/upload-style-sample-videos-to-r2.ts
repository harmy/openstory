#!/usr/bin/env bun
/**
 * Upload style sample videos to the R2 public bucket (issue #718).
 *
 * Scans `sample-videos/{slug}/` produced by generate-style-sample-videos.ts and
 * uploads each `canonical.mp4` / `bespoke.mp4` to
 * `styles/{slug}/{canonical|bespoke}.mp4` in the public assets bucket.
 *
 * Default upload path is the wrangler CLI (account-wide CLOUDFLARE_API_TOKEN /
 * `wrangler login`, which has write access to the public bucket), run through a
 * concurrency pool. Pass --s3 to use direct S3 PutObject (faster, no process
 * spawn) — but only if your R2 keys are actually scoped to this bucket.
 *
 * Usage:
 *   bun scripts/upload-style-sample-videos-to-r2.ts            # upload all found
 *   bun scripts/upload-style-sample-videos-to-r2.ts --dry-run  # list keys only
 *   bun scripts/upload-style-sample-videos-to-r2.ts --filter product-ad
 *   bun scripts/upload-style-sample-videos-to-r2.ts --s3       # direct S3 (opt-in)
 */
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SAMPLE_DIR = path.join(process.cwd(), 'sample-videos');
const KINDS = ['canonical', 'bespoke'] as const;
const UPLOAD_CONCURRENCY = Number(process.env.UPLOAD_CONCURRENCY ?? '12');

const isDryRun = process.argv.includes('--dry-run');
const filterIdx = process.argv.findIndex((a) => a === '--filter');
const filter = filterIdx >= 0 ? process.argv[filterIdx + 1] : undefined;

const R2_CONFIG = {
  bucket: process.env.R2_PUBLIC_ASSETS_BUCKET || 'openstory-public-assets',
  url: `https://${process.env.VITE_R2_PUBLIC_ASSETS_DOMAIN || 'assets.openstory.so'}`,
};

/** Direct-S3 client, opt-in via --s3 (see upload-style-previews-to-r2.ts). */
function createR2S3Client(): S3Client | null {
  if (!process.argv.includes('--s3')) return null;
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      '--s3 requires R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY (and the key must have write access to the bucket)'
    );
  }
  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
}

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

/** Upload one mp4 via S3 (opt-in) or the wrangler CLI fallback. */
async function uploadObject(
  s3: S3Client | null,
  localPath: string,
  r2Key: string
): Promise<void> {
  if (s3) {
    await s3.send(
      new PutObjectCommand({
        Bucket: R2_CONFIG.bucket,
        Key: r2Key,
        Body: await readFile(localPath),
        ContentType: 'video/mp4',
        CacheControl: 'public, max-age=2592000',
      })
    );
    return;
  }
  try {
    await execFileAsync('bunx', [
      'wrangler',
      'r2',
      'object',
      'put',
      `${R2_CONFIG.bucket}/${r2Key}`,
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

  const s3 = createR2S3Client();
  const concurrency = s3 ? UPLOAD_CONCURRENCY : Math.min(UPLOAD_CONCURRENCY, 6);
  console.log(
    `Uploading via ${s3 ? 'S3' : 'wrangler'} (${concurrency} concurrent)…`
  );

  let success = 0;
  let index = 0;
  const failures: string[] = [];
  const worker = async () => {
    while (index < uploads.length) {
      const u = uploads[index++];
      if (!u) break;
      try {
        await uploadObject(s3, u.localPath, u.r2Key);
        success++;
        console.log(`  ✅ ${u.r2Key}`);
      } catch (error) {
        failures.push(u.r2Key);
        console.error(
          `  ❌ ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(concurrency, uploads.length) }, worker)
  );

  console.log(`\nUploaded ${success}/${uploads.length}.`);
  if (failures.length > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
