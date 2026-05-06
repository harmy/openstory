/**
 * R2 upload recorder for e2e tests.
 *
 * Wraps `uploadFile()` (see storage-s3.ts) so the full-pipeline test doesn't
 * re-upload the same generated images/videos/audio to real R2 on every run.
 * Mirrors the philosophy of e2e/mocks/fal-handler.ts:
 *
 * - **Record** (`R2_MOCK_MODE=record`): real upload happens, then the resulting
 *   `UploadResult` (key + publicUrl) is saved as a fixture keyed by a stable
 *   fingerprint of the request.
 * - **Replay** (default in E2E): the wrapper short-circuits the upload and
 *   returns the recorded `UploadResult`. The recorded `publicUrl` still points
 *   at the real R2 object that was persisted during the original record run,
 *   so `<img>` and `<video>` downloads continue to work normally.
 *
 * Keys embed runtime ULIDs (teamId/sequenceId/frameId) that drift across runs,
 * so we normalise them to `<ULID>` placeholders before hashing — same trick as
 * `fal-handler.ts:normalizeForHash`.
 *
 * The fingerprint deliberately does NOT include body content. The pipeline
 * upstream of every R2 upload is deterministic in replay mode (LLM via aimock
 * → fal API via fal-handler → fal CDN serves the same bytes for the same URL),
 * so "same logical key" → "same body content" is invariant. Skipping body in
 * the fingerprint lets `tryReplay` answer without consuming the body stream,
 * which avoids pulling MBs of fal CDN data per cache hit. The recorded fixture
 * still stores `bodyHash` and `bodySize` as metadata for debugging.
 *
 * This module imports `node:fs` and is loaded only via `storage-s3.ts`. On
 * Cloudflare the `#storage` alias resolves to `storage-cloudflare.ts` so this
 * file is never bundled into the worker.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { UploadResult } from './buckets';

export type UploadFingerprint = {
  bucket: string;
  key: string;
  contentType?: string;
};

type FixtureFile = {
  request: {
    bucket: string;
    key: string;
    normalisedKey: string;
    contentType?: string;
    bodyHash: string;
    bodySize: number;
  };
  response: UploadResult;
};

const FIXTURE_DIR = resolve(process.cwd(), 'e2e/fixtures/recorded/r2');

const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
// Filenames embed a per-upload short hash (6 chars in video/audio storage,
// 8 chars in merged-video) immediately before `_openstory.<ext>`. That's a
// fresh ULID slice on each upload, so it varies across runs and must be
// normalised the same way as ULIDs/UUIDs to keep fingerprints stable.
const SHORT_HASH_RE = /(^|[/_])[a-zA-Z0-9]{6,8}(_openstory\.)/g;

function normaliseKey(key: string): string {
  return key
    .replace(ULID_RE, '<ULID>')
    .replace(UUID_RE, '<UUID>')
    .replace(SHORT_HASH_RE, '$1<HASH>$2');
}

function bodyHashHex(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function fingerprintHash(fp: UploadFingerprint): string {
  return createHash('sha256')
    .update(
      [fp.bucket, normaliseKey(fp.key), fp.contentType ?? ''].join('\x00')
    )
    .digest('hex')
    .slice(0, 16);
}

// Build a readable filename slug from the key by dropping the bucket prefix
// (already used as the folder) and any ULID/UUID material. What's left are
// the literal path anchors a human would recognise — e.g. `frames`,
// `thumbnail.jpg`, `sheet.png`. If everything was ULID, fall back to just
// the hash.
function fixturePath(fp: UploadFingerprint, hash: string): string {
  const segments = fp.key.split('/').slice(1);
  const meaningful = segments
    .map((seg) => seg.replace(ULID_RE, '').replace(UUID_RE, ''))
    .map((seg) => seg.replace(SHORT_HASH_RE, '$1$2'))
    .map((seg) => seg.replace(/^\.+/, '')) // drop leading dots so we don't make hidden files
    .filter((seg) => seg.length > 0);
  const slug = meaningful
    .join('__')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/-+/g, '-');
  const filename = slug ? `${slug}__${hash}.json` : `${hash}.json`;
  return resolve(FIXTURE_DIR, fp.bucket, filename);
}

export function tryReplay(fp: UploadFingerprint): UploadResult | null {
  const filePath = fixturePath(fp, fingerprintHash(fp));
  if (!existsSync(filePath)) return null;
  const fixture: FixtureFile = JSON.parse(readFileSync(filePath, 'utf8'));
  return fixture.response;
}

export function record(
  fp: UploadFingerprint,
  body: Uint8Array,
  response: UploadResult
): void {
  const filePath = fixturePath(fp, fingerprintHash(fp));
  const fixture: FixtureFile = {
    request: {
      bucket: fp.bucket,
      key: fp.key,
      normalisedKey: normaliseKey(fp.key),
      contentType: fp.contentType,
      bodyHash: bodyHashHex(body),
      bodySize: body.byteLength,
    },
    response,
  };
  const parent = dirname(filePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(filePath, JSON.stringify(fixture, null, 2));
}
