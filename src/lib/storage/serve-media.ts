import { getEnv } from '#env';
import { serveFile } from '#storage';
import { isLocalStorageServing } from './buckets';

/**
 * Handler logic for the `/r2/$` serve route (src/routes/r2.$.ts) — split out
 * so the redirect-vs-stream decision is unit-testable:
 *
 * - Without a public CDN domain (local dev, e2e, CDN-less deploy-button
 *   workers): stream the object straight from the R2 binding.
 * - With `R2_PUBLIC_STORAGE_DOMAIN` configured: 302 to it, so media bytes
 *   are served (and cached) by the R2 domain's edge instead of this worker.
 */
export async function serveStoredMedia(
  key: string,
  request: Request
): Promise<Response> {
  if (!isLocalStorageServing()) {
    return Response.redirect(
      `https://${getEnv().R2_PUBLIC_STORAGE_DOMAIN}/${key}`,
      302
    );
  }
  return serveFile(key, request);
}
