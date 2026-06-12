/**
 * Outbound-URL shim for stored media.
 *
 * Stored media URLs are origin-relative (`/r2/<key>`, see #894) — browsers
 * resolve them against the serving origin, but anything we hand to a REAL
 * external service must be made publicly fetchable first:
 *
 * - With a public CDN domain configured (production / opt-in remote dev):
 *   absolutize against `R2_PUBLIC_STORAGE_DOMAIN` at the moment of use.
 * - Without one (local dev / e2e record, but also CDN-less production
 *   deploy-button workers — this path is load-bearing in real deployments,
 *   not just a dev convenience), there is no public URL at all:
 *   - fal model inputs (Kling `image_url`, nano-banana `image_urls`, …) →
 *     read the bytes from the R2 binding and upload them to fal storage,
 *     substituting the returned fal URL.
 *   - OpenRouter vision messages → inline the bytes as a base64 data part.
 *
 * Pass-through cases:
 * - the URL isn't ours (fal CDN outputs, user-supplied externals, legacy
 *   absolute CDN-domain rows — still fetchable on their original domain), or
 * - we're in e2e REPLAY (aimock string-matches request bodies and never
 *   fetches URLs, so the relative URL can pass through untouched). Record
 *   mode (`E2E_RECORD=1`) talks to real providers and takes the shim path.
 */

import { getEnv } from '#env';
// Deliberately the UPSTREAM client, not the fal-config wrapper: the shim only
// runs when talking to REAL fal (local dev / e2e record), and routing the
// storage upload through FAL_PROXY_URL would just record meaningless
// storage-initiate fixtures in aimock. Model calls still go through the
// proxied clients as usual.
import { createFalClient } from '@fal-ai/client';
import { readStorageObject } from '#storage';
import { r2KeyFromUrl, toCdnUrl } from './buckets';

function isReplayMode(): boolean {
  const env = getEnv();
  return env.E2E_TEST === 'true' && env.E2E_RECORD !== '1';
}

async function readStoredBytes(
  key: string
): Promise<{ bytes: Uint8Array<ArrayBuffer>; contentType: string }> {
  const object = await readStorageObject(key);
  if (!object) {
    throw new Error(`Failed to read storage object ${key}: not found`);
  }
  return object;
}

/**
 * Make a stored media URL fetchable by real fal. CDN-backed deployments
 * absolutize; local `/r2/` URLs are uploaded to fal storage (short-lived
 * scratch space — these are model inputs, not user content); everything else
 * passes through.
 */
export async function ensureExternallyFetchableUrl(
  url: string
): Promise<string> {
  const key = r2KeyFromUrl(url);
  if (key === null) return url;
  const cdnUrl = toCdnUrl(url);
  if (cdnUrl) return cdnUrl;
  if (isReplayMode()) return url;
  const { bytes, contentType } = await readStoredBytes(key);
  const fal = createFalClient({ credentials: getEnv().FAL_KEY });
  const filename = key.split('/').pop() || 'upload';
  const file = new File([bytes], filename, { type: contentType });
  return fal.storage.upload(file);
}

export async function ensureExternallyFetchableUrls(
  urls: string[]
): Promise<string[]> {
  return Promise.all(urls.map((url) => ensureExternallyFetchableUrl(url)));
}

/**
 * Vision-message image source for a storage URL: stored URLs become CDN
 * absolutes when a domain is configured, or inline base64 data parts when
 * served locally (OpenRouter can't fetch what only this machine can see);
 * public URLs stay URL-sourced.
 */
export async function toVisionImageSource(
  url: string
): Promise<
  | { type: 'url'; value: string }
  | { type: 'data'; value: string; mimeType: string }
> {
  const key = r2KeyFromUrl(url);
  if (key === null) return { type: 'url', value: url };
  const cdnUrl = toCdnUrl(url);
  if (cdnUrl) return { type: 'url', value: cdnUrl };
  if (isReplayMode()) return { type: 'url', value: url };
  const { bytes, contentType } = await readStoredBytes(key);
  return {
    type: 'data',
    value: toBase64(bytes),
    mimeType: contentType || 'image/png',
  };
}

// Web-safe base64 (no node:buffer — this module sits on an import path that
// Vite also walks for the client bundle, where node:* is externalized and
// throws at runtime). Chunked to stay under the JS argument-count limit.
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
