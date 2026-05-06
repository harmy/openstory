#!/usr/bin/env bun
/**
 * One-shot migration: existing R2 fixtures were keyed with per-upload short
 * hashes baked into the filename (e.g. `_h6e28g_openstory.mp4`). Those drift
 * across runs, so cache lookups always missed and the lenient default mode
 * silently re-uploaded to real R2. After updating r2-recorder.ts to strip the
 * shortHash from the fingerprint, this script renames each fixture file to
 * its new normalised path so existing recordings remain reusable.
 *
 * Idempotent: skips files already at the expected path.
 *
 * Run once: `bun scripts/migrate-r2-fixtures.ts`
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';

const FIXTURE_DIR = resolve(process.cwd(), 'e2e/fixtures/recorded/r2');

const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const SHORT_HASH_RE = /(^|[/_])[a-zA-Z0-9]{6,8}(_openstory\.)/g;

function normaliseKey(key: string): string {
  return key
    .replace(ULID_RE, '<ULID>')
    .replace(UUID_RE, '<UUID>')
    .replace(SHORT_HASH_RE, '$1<HASH>$2');
}

function fingerprintHash(
  bucket: string,
  key: string,
  contentType: string | undefined
): string {
  return createHash('sha256')
    .update([bucket, normaliseKey(key), contentType ?? ''].join('\x00'))
    .digest('hex')
    .slice(0, 16);
}

type Fixture = {
  request: { bucket: string; key: string; contentType?: string };
};

function readFixture(path: string): Fixture {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fixturePath(bucket: string, key: string, hash: string): string {
  const segments = key.split('/').slice(1);
  const meaningful = segments
    .map((seg) => seg.replace(ULID_RE, '').replace(UUID_RE, ''))
    .map((seg) => seg.replace(SHORT_HASH_RE, '$1$2'))
    .map((seg) => seg.replace(/^\.+/, ''))
    .filter((seg) => seg.length > 0);
  const slug = meaningful
    .join('__')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-');
  const filename = slug ? `${slug}__${hash}.json` : `${hash}.json`;
  return resolve(FIXTURE_DIR, bucket, filename);
}

if (!existsSync(FIXTURE_DIR)) {
  console.error(`No fixtures dir at ${FIXTURE_DIR}`);
  process.exit(1);
}

let renamed = 0;
let unchanged = 0;
let collisions = 0;

for (const bucket of readdirSync(FIXTURE_DIR)) {
  const bucketDir = resolve(FIXTURE_DIR, bucket);
  if (!statSync(bucketDir).isDirectory()) continue;

  for (const file of readdirSync(bucketDir)) {
    if (!file.endsWith('.json')) continue;
    const oldPath = resolve(bucketDir, file);
    const fixture = readFixture(oldPath);
    const { bucket: fixtureBucket, key, contentType } = fixture.request;
    const newHash = fingerprintHash(fixtureBucket, key, contentType);
    const newPath = fixturePath(fixtureBucket, key, newHash);

    if (oldPath === newPath) {
      unchanged++;
      continue;
    }
    if (existsSync(newPath)) {
      // Multiple stale recordings of the same logical resource. The target
      // is the canonical one — drop the orphan so strict-mode lookups don't
      // get confused by leftover files with old shortHashes in their names.
      unlinkSync(oldPath);
      console.log(
        `[prune] dropped stale duplicate: ${file} (target ${newPath.replace(`${FIXTURE_DIR}/`, '')} already migrated)`
      );
      collisions++;
      continue;
    }

    // Update normalisedKey field to reflect new normalisation rules
    const updated = {
      ...fixture,
      request: { ...fixture.request, normalisedKey: normaliseKey(key) },
    };
    writeFileSync(newPath, JSON.stringify(updated, null, 2));
    unlinkSync(oldPath);
    renamed++;
    console.log(
      `[ok] ${file} → ${newPath.replace(`${FIXTURE_DIR}/${bucket}/`, '')}`
    );
  }
}

console.log(
  `\nDone. renamed=${renamed} unchanged=${unchanged} collisions=${collisions}`
);
