/**
 * Storage Cloudflare — Native R2 binding implementation.
 * Used on Cloudflare Workers via the workerd condition in package.json imports.
 *
 * Signed URLs are not supported by R2 bindings and lazy-import the S3 SDK.
 */

import { env as workerEnv } from 'cloudflare:workers';
import { getEnv } from '#env';
import {
  buildR2Key,
  getPublicUrl,
  type StorageBucket,
  type StorageFileInfo,
  type UploadResult,
} from './buckets';

function getR2Bucket(): R2Bucket {
  // Reach for the binding via `cloudflare:workers` directly so the type
  // resolves to R2Bucket. `#env` resolves to a process.env shim at typecheck
  // time (because tsgo doesn't apply the `workerd` import condition), which
  // would type bindings as `string`.
  const bucket = workerEnv.R2_STORAGE_BUCKET;
  if (!bucket) {
    throw new Error(
      'R2 binding "R2_STORAGE_BUCKET" not found. Ensure r2_buckets is configured in wrangler.jsonc'
    );
  }
  return bucket;
}

const R2_MOCK_URL = 'http://localhost:4011';

type LookupResponse = { hit: true; response: UploadResult } | { hit: false };

// Drains any of the union members into a Uint8Array for hashing + r2.put().
// We have to materialise once to compute the fingerprint hash; the same buffer
// is then forwarded to the binding so we don't pay the read twice.
async function toUint8Array(
  file: File | Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>
): Promise<Uint8Array> {
  if (file instanceof Uint8Array) return file;
  if (file instanceof ArrayBuffer) return new Uint8Array(file);
  if (file instanceof ReadableStream) {
    return new Uint8Array(await new Response(file).arrayBuffer());
  }
  return new Uint8Array(await file.arrayBuffer());
}

function hexHash(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function uploadFile(
  bucket: StorageBucket,
  path: string,
  file: File | Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
  options?: {
    upsert?: boolean;
    contentType?: string;
    cacheControl?: string;
  }
): Promise<UploadResult> {
  const key = buildR2Key(bucket, path);
  const env = getEnv();

  try {
    // E2E: route through the r2-mock sidecar (which owns r2-recorder + the
    // fixture files). On replay we never invoke the R2 binding; on record we
    // do the real put (binding is `remote: true` in [env.test]) and persist
    // the fingerprint via the sidecar's record endpoint.
    if (env.E2E_TEST === 'true') {
      const body = await toUint8Array(file);
      // .slice() forces a non-shared ArrayBuffer so BufferSource accepts it
      // (Uint8Array<ArrayBufferLike>.buffer could otherwise be SharedArrayBuffer).
      const bodyHash = hexHash(
        await crypto.subtle.digest('SHA-256', body.slice().buffer)
      );
      const fp = { bucket, key, contentType: options?.contentType, bodyHash };

      const lookupRes = await fetch(`${R2_MOCK_URL}/e2e/r2/lookup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(fp),
      });
      const lookup: LookupResponse = await lookupRes.json();
      if (lookup.hit) return lookup.response;

      const recording = env.E2E_RECORD === '1';
      if (!recording) {
        throw new Error(
          `[r2-mock] No fixture for ${bucket}/${path}. Re-record with E2E_RECORD=1.`
        );
      }

      // Recording: write to real R2 via the binding (which is `remote: true`
      // in [env.test]), then persist the fixture via the sidecar.
      const r2 = getR2Bucket();
      await r2.put(key, body, {
        httpMetadata: {
          contentType: options?.contentType,
          cacheControl: options?.cacheControl ?? 'public, max-age=31536000',
        },
      });
      const publicUrl = getPublicUrl(bucket, path);
      const response: UploadResult = { path: key, publicUrl, fullPath: key };

      await fetch(`${R2_MOCK_URL}/e2e/r2/record`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...fp, bodySize: body.byteLength, response }),
      });
      return response;
    }

    const r2 = getR2Bucket();
    // R2 natively accepts all types in our union (ReadableStream, ArrayBuffer,
    // ArrayBufferView, Blob) — no conversion needed.
    await r2.put(key, file, {
      httpMetadata: {
        contentType: options?.contentType,
        cacheControl: options?.cacheControl ?? 'public, max-age=31536000',
      },
    });

    const publicUrl = getPublicUrl(bucket, path);

    return {
      path: key,
      publicUrl,
      fullPath: key,
    };
  } catch (error) {
    throw new Error(
      `Failed to upload file to ${bucket}/${path}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getSignedUrl(
  bucket: StorageBucket,
  path: string,
  _expiresIn = 3600
): Promise<string> {
  // R2 files are publicly accessible via CDN — no signing needed on Cloudflare.
  // The S3 SDK fallback previously here pulled ~19MB of @aws-sdk into the Worker
  // bundle, contributing to OOM (error 1102) on the 128MB Workers memory limit.
  return getPublicUrl(bucket, path);
}

export async function getSignedUrlWithDownload(
  bucket: StorageBucket,
  path: string,
  _filename: string,
  _expiresIn = 3600
): Promise<string> {
  // R2 files are publicly accessible — return public URL.
  // Custom download filename (ResponseContentDisposition) is not supported
  // without S3 presigned URLs, but keeping the AWS SDK out of the Worker
  // bundle is worth the trade-off. Browser "Save As" still works.
  return getPublicUrl(bucket, path);
}

export async function getSignedUploadUrl(
  bucket: StorageBucket,
  path: string,
  contentType: string,
  _expiresIn = 600
): Promise<{
  uploadUrl: string;
  publicUrl: string;
  path: string;
  contentType: string;
}> {
  // R2 bindings don't support presigned URLs — proxy through the worker instead
  // Pass raw path — uploadFile will call buildR2Key itself
  const params = new URLSearchParams({ bucket, path, contentType });
  const uploadUrl = `/api/storage/upload?${params}`;
  const publicUrl = getPublicUrl(bucket, path);
  return { uploadUrl, publicUrl, path: buildR2Key(bucket, path), contentType };
}

export async function deleteFile(
  bucket: StorageBucket,
  path: string
): Promise<void> {
  const r2 = getR2Bucket();
  const key = buildR2Key(bucket, path);

  try {
    await r2.delete(key);
  } catch (error) {
    throw new Error(
      `Failed to delete file from ${bucket}/${path}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteFiles(
  bucket: StorageBucket,
  paths: string[]
): Promise<void> {
  if (paths.length === 0) return;

  const r2 = getR2Bucket();

  try {
    const keys = paths.map((path) => buildR2Key(bucket, path));
    await r2.delete(keys);
  } catch (error) {
    throw new Error(
      `Failed to delete files from ${bucket}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function listFiles(
  bucket: StorageBucket,
  path = '',
  options?: {
    limit?: number;
    offset?: number;
    sortBy?: { column: string; order: 'asc' | 'desc' };
  }
): Promise<StorageFileInfo[]> {
  const r2 = getR2Bucket();
  const prefix = buildR2Key(bucket, path);

  try {
    const listed = await r2.list({
      prefix,
      limit: options?.limit,
      include: ['httpMetadata'],
    });

    return listed.objects.map((obj) => ({
      name: obj.key.replace(`${prefix}/`, ''),
      id: obj.key,
      updated_at: obj.uploaded.toISOString(),
      created_at: obj.uploaded.toISOString(),
      last_accessed_at: obj.uploaded.toISOString(),
      metadata: {
        size: obj.size,
        mimetype: obj.httpMetadata?.contentType ?? '',
        cacheControl: obj.httpMetadata?.cacheControl ?? '',
        eTag: obj.httpEtag,
      },
    }));
  } catch (error) {
    throw new Error(
      `Failed to list files in ${bucket}/${path}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function moveFile(
  bucket: StorageBucket,
  fromPath: string,
  toPath: string
): Promise<void> {
  await copyFile(bucket, fromPath, toPath);
  await deleteFile(bucket, fromPath);
}

export async function copyFile(
  bucket: StorageBucket,
  fromPath: string,
  toPath: string
): Promise<void> {
  const r2 = getR2Bucket();
  const sourceKey = buildR2Key(bucket, fromPath);
  const destKey = buildR2Key(bucket, toPath);

  try {
    const source = await r2.get(sourceKey);
    if (!source) {
      throw new Error(`Source file not found: ${fromPath}`);
    }

    await r2.put(destKey, source.body, {
      httpMetadata: source.httpMetadata,
      customMetadata: source.customMetadata,
    });
  } catch (error) {
    throw new Error(
      `Failed to copy file from ${fromPath} to ${toPath}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function fileExists(
  bucket: StorageBucket,
  path: string
): Promise<boolean> {
  const r2 = getR2Bucket();
  const key = buildR2Key(bucket, path);

  try {
    const head = await r2.head(key);
    return head !== null;
  } catch {
    return false;
  }
}
