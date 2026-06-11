/**
 * SSRF-hardened fetch for caller-supplied image URLs (public API element
 * ingestion). An authenticated API caller is still untrusted for the purpose of
 * what *our* server will fetch, so before fetching we:
 *   - allow only http/https,
 *   - block loopback / private / link-local / reserved IP literals and ambiguous
 *     numeric (decimal/hex/octal) or IPv6 host encodings, plus internal-looking
 *     hostnames (localhost, *.internal, *.local),
 *   - never follow redirects (a public URL can't bounce to an internal one),
 *   - require a real image Content-Type from the *response* (not the URL ext),
 *   - cap the response size.
 *
 * Runtime note: this runs on Cloudflare Workers, which has no DNS API, so we
 * can't pin the resolved address — DNS-rebinding is the residual gap. In
 * practice Workers egress through Cloudflare's network (no VPC / no instance
 * metadata endpoint reachable), which blunts the classic cloud-metadata target;
 * the host checks below close the direct-literal and internal-name vectors.
 * Errors are deliberately generic so we don't reflect the URL or upstream
 * status back to the caller.
 */

import { uploadFile } from '#storage';
import { generateId } from '@/lib/db/id';
import { ValidationError } from '@/lib/errors';
import { getPublicUrl, type StorageBucket } from '@/lib/storage/buckets';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB

/** content-type → file extension for the storage key. */
const ALLOWED_IMAGE_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

function isPrivateIpv4(host: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  const d = Number(m[4]);
  if ([a, b, c, d].some((n) => n > 255)) return true; // malformed → reject
  return (
    a === 0 || // 0.0.0.0/8
    a === 10 || // 10/8
    a === 127 || // loopback
    (a === 169 && b === 254) || // link-local / cloud metadata
    (a === 172 && b >= 16 && b <= 31) || // 172.16/12
    (a === 192 && b === 168) || // 192.168/16
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64/10
    a >= 224 // multicast / reserved
  );
}

/**
 * Reject host forms that are IP literals (other than verified-public dotted
 * IPv4), ambiguous numeric encodings, IPv6, or internal-looking names. Returns
 * the validated URL.
 */
export function assertSafeImageUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new ValidationError('Element image URL is invalid.');
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ValidationError('Element image URL must use http or https.');
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Internal-looking names.
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    throw new ValidationError('Element image URL is not allowed.');
  }

  // IPv6 literal (contains a colon) — uncommon for hosted images; reject to
  // avoid ::1 / fc00::/7 / fe80::/10 / ::ffff:v4 mapping bypasses.
  if (host.includes(':')) {
    throw new ValidationError('Element image URL is not allowed.');
  }

  // Ambiguous numeric encodings (decimal 2130706433, hex 0x7f000001, octal):
  // these are almost always SSRF probes for hosted-image use, so reject.
  if (/^0x[0-9a-f]+$/i.test(host) || /^\d+$/.test(host)) {
    throw new ValidationError('Element image URL is not allowed.');
  }

  // Dotted IPv4 literal in a private/reserved range.
  if (isPrivateIpv4(host)) {
    throw new ValidationError('Element image URL is not allowed.');
  }

  return url;
}

/**
 * Fetch a caller-supplied image URL safely. Validates the host, refuses
 * redirects, enforces an image Content-Type from the response, and caps size.
 * Returns the bytes, the validated content type, and its file extension.
 */
async function fetchSafeImage(
  rawUrl: string
): Promise<{ bytes: Uint8Array; contentType: string; extension: string }> {
  const url = assertSafeImageUrl(rawUrl);

  let res: Response;
  try {
    res = await fetch(url, { redirect: 'manual' });
  } catch {
    throw new ValidationError('Element image could not be fetched.');
  }

  // redirect: 'manual' surfaces 3xx as a non-ok response — never followed.
  if (!res.ok) {
    throw new ValidationError('Element image could not be fetched.');
  }

  const contentType =
    (res.headers.get('content-type') ?? '')
      .split(';')[0]
      ?.trim()
      .toLowerCase() ?? '';
  const extension = ALLOWED_IMAGE_TYPES[contentType];
  if (!extension) {
    throw new ValidationError(
      'Element image must be a PNG, JPEG, WebP, GIF, or AVIF.'
    );
  }

  const declaredLength = Number(res.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_IMAGE_BYTES) {
    throw new ValidationError('Element image is too large (max 20 MB).');
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    throw new ValidationError('Element image is too large (max 20 MB).');
  }

  return { bytes, contentType, extension };
}

export type IngestedImage = {
  /** Bucket-relative temp path, e.g. `<teamId>/temp/<id>.png`. */
  tempPath: string;
  /** Public URL of the uploaded temp object. */
  publicUrl: string;
  extension: string;
  contentType: string;
};

/**
 * SSRF-safely fetch a caller-supplied image URL and store it under the given
 * bucket's `temp/` prefix, returning the temp path + public URL. The temp
 * object is later promoted to permanent storage by the relevant create flow
 * (elements → `promoteTempElements`; talent/locations → their create cores).
 */
export async function ingestImageToTempBucket(
  url: string,
  bucket: StorageBucket,
  teamId: string
): Promise<IngestedImage> {
  const { bytes, contentType, extension } = await fetchSafeImage(url);
  const tempPath = `${teamId}/temp/${generateId()}.${extension}`;
  await uploadFile(bucket, tempPath, bytes, { contentType });
  return {
    tempPath,
    publicUrl: getPublicUrl(bucket, tempPath),
    extension,
    contentType,
  };
}
