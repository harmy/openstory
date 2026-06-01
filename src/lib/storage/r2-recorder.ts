/**
 * R2 upload recorder for e2e tests.
 *
 * Wraps `uploadFile()` (see storage-s3.ts) so the full-pipeline test doesn't
 * re-upload the same generated images/videos/audio to real R2 on every run.
 * Mirrors the philosophy of e2e/mocks/fal-handler.ts:
 *
 * - **Record** (`E2E_RECORD=1`): real upload happens, then the resulting
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
 * Several upload paths produce keys whose every segment is a ULID
 * (`thumbnails/teams/<ULID>/sequences/<ULID>/frames/<ULID>/<ULID>.png`), so
 * after normalisation many distinct uploads share a single fingerprint. We
 * therefore store an array of entries per fixture file and disambiguate by
 * SHA-256 of the body when more than one entry exists. The body content is
 * deterministic across runs (LLM via aimock → fal API via fal-handler →
 * fal CDN serves the same bytes for the same URL), so the same upload always
 * resolves to the same recorded response.
 *
 * `tryReplay` returns a tagged result so the caller can short-circuit on
 * unique fingerprints without consuming the body stream (avoids pulling MBs
 * from fal CDN per cache hit). Only collisions pay the body-read cost via
 * `tryReplayWithBody`.
 *
 * This module imports `node:fs` and runs only in the Node-side aimock server
 * (`e2e/mocks/aimock-server.ts`), which exposes it over HTTP at port 4011.
 * `storage-cloudflare.ts` under Workerd posts `{ bucket, key, bodyHash }` to
 * the aimock endpoint instead of importing this module directly — keeping
 * fs/crypto out of the worker bundle.
 *
 * Recording vs replay contract (critical for full-pipeline e2e):
 * - When E2E_RECORDING: the lookup handler only consults the in-memory
 *   `recordedThisSession` map (populated by this run's /record calls). Old
 *   fixtures on disk are ignored. This ensures a re-record actually captures
 *   whatever bodies the current code + aimock fixtures produce.
 * - On normal replay: we use the on-disk fixtures with strict bodyHash
 *   matching (no more blind trust of singleton entries).
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

type FixtureEntry = {
  request: {
    key: string;
    bodyHash: string;
    bodySize: number;
  };
  response: UploadResult;
};

type FixtureFile = {
  fingerprint: {
    bucket: string;
    normalisedKey: string;
    contentType?: string;
  };
  entries: FixtureEntry[];
};

// Legacy single-entry shape — still readable so existing fixtures don't all
// need re-recording. Written-back as the new array shape on next record.
type LegacyFixtureFile = {
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

export type ReplayResult =
  | { type: 'hit'; response: UploadResult }
  | { type: 'need-body' }
  | { type: 'miss' };

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

function readFixture(filePath: string): FixtureFile | null {
  if (!existsSync(filePath)) return null;
  const raw: FixtureFile | LegacyFixtureFile = JSON.parse(
    readFileSync(filePath, 'utf8')
  );
  if ('entries' in raw) return raw;
  if ('request' in raw && 'response' in raw) {
    return {
      fingerprint: {
        bucket: raw.request.bucket,
        normalisedKey: raw.request.normalisedKey,
        contentType: raw.request.contentType,
      },
      entries: [
        {
          request: {
            key: raw.request.key,
            bodyHash: raw.request.bodyHash,
            bodySize: raw.request.bodySize,
          },
          response: raw.response,
        },
      ],
    };
  }
  return null;
}

// Fingerprints we've already touched during this record run. First touch
// clears any pre-existing entries (so re-records don't accumulate stale
// fixtures from previous runs); subsequent touches append.
const recordedThisRun = new Set<string>();

/**
 * Bodies recorded via /record *in this sidecar process* (i.e. during the
 * current `E2E_RECORD=1` invocation).
 *
 * This is the source of truth for lookup hits while recording. We deliberately
 * do *not* consult on-disk fixtures from previous runs when E2E_RECORDING is
 * true — otherwise a stale singleton or partial multi-entry fixture would
 * short-circuit the record path for new/different image bodies produced by
 * the current test run, leaving the fixture file missing those hashes on the
 * next replay.
 *
 * Populated only by recordWithHash. Read only by the recording-mode path in
 * r2-mock-server.ts.
 */
const recordedThisSession = new Map<string, Map<string, UploadResult>>();

function fingerprintKey(fp: UploadFingerprint): string {
  return [fp.bucket, normaliseKey(fp.key), fp.contentType ?? ''].join('\x00');
}

export function tryReplay(fp: UploadFingerprint): ReplayResult {
  const filePath = fixturePath(fp, fingerprintHash(fp));
  const fixture = readFixture(filePath);
  if (!fixture || fixture.entries.length === 0) return { type: 'miss' };
  // Always fall through to the bodyHash-disambiguated path. We no longer
  // blindly trust a singleton entry — the bodyHash sent by the worker on
  // every lookup is authoritative. This eliminates a class of "stale
  // fixture" surprises when the same normalised key has been used for
  // different content across recordings.
  return { type: 'need-body' };
}

export function tryReplayWithBody(
  fp: UploadFingerprint,
  body: Uint8Array
): UploadResult | null {
  return tryReplayWithBodyHash(fp, bodyHashHex(body));
}

// Same as tryReplayWithBody but accepts a precomputed body hash so callers
// that already hashed the body (e.g. the worker computing crypto.subtle on
// the way to aimock) don't have to ship megabytes over HTTP just to re-hash.
export function tryReplayWithBodyHash(
  fp: UploadFingerprint,
  bodyHash: string
): UploadResult | null {
  const filePath = fixturePath(fp, fingerprintHash(fp));
  const fixture = readFixture(filePath);
  if (!fixture) return null;
  const match = fixture.entries.find((e) => e.request.bodyHash === bodyHash);
  return match?.response ?? null;
}

/**
 * Recording-session lookup. Only returns a hit for bodies that were
 * successfully passed through `recordWithHash` in *this* sidecar process.
 * Never reads from disk. This is what the /lookup handler uses when
 * E2E_RECORDING, guaranteeing that every distinct body the current test
 * run actually produced will have caused a real R2 put + fixture write.
 */
export function tryReplayRecordedThisSession(
  fp: UploadFingerprint,
  bodyHash: string
): UploadResult | null {
  const byBody = recordedThisSession.get(fingerprintKey(fp));
  return byBody?.get(bodyHash) ?? null;
}

export function record(
  fp: UploadFingerprint,
  body: Uint8Array,
  response: UploadResult
): void {
  recordWithHash(fp, bodyHashHex(body), body.byteLength, response);
}

// Same as record but accepts a precomputed body hash + size — see
// tryReplayWithBodyHash for rationale.
export function recordWithHash(
  fp: UploadFingerprint,
  bodyHash: string,
  bodySize: number,
  response: UploadResult
): void {
  const filePath = fixturePath(fp, fingerprintHash(fp));
  const fpKey = fingerprintKey(fp);

  // First record() this run for this fingerprint replaces any stale fixture
  // wholesale; later calls append/update entries within the same run.
  let entries: FixtureEntry[] = [];
  if (recordedThisRun.has(fpKey)) {
    const existing = readFixture(filePath);
    if (existing) entries = existing.entries;
  }
  recordedThisRun.add(fpKey);

  const newEntry: FixtureEntry = {
    request: { key: fp.key, bodyHash, bodySize },
    response,
  };
  const existingIdx = entries.findIndex((e) => e.request.bodyHash === bodyHash);
  if (existingIdx >= 0) {
    entries[existingIdx] = newEntry;
  } else {
    entries.push(newEntry);
  }

  const fixture: FixtureFile = {
    fingerprint: {
      bucket: fp.bucket,
      normalisedKey: normaliseKey(fp.key),
      contentType: fp.contentType,
    },
    entries,
  };
  const parent = dirname(filePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  writeFileSync(filePath, JSON.stringify(fixture, null, 2));

  // Also record in the in-memory session map so that subsequent /lookup
  // calls in the same recording run (including for other bodies of the
  // same fp) can short-circuit without suppressing the record path for
  // bodies we haven't seen yet.
  let byBody = recordedThisSession.get(fpKey);
  if (!byBody) {
    byBody = new Map();
    recordedThisSession.set(fpKey, byBody);
  }
  byBody.set(bodyHash, response);
}
