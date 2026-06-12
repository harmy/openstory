import { createFileRoute } from '@tanstack/react-router';
import { serveStoredMedia } from '@/lib/storage/serve-media';

/**
 * Serve route for stored media. Stored media URLs are origin-relative
 * (`/r2/<key>`, see #894), so every deployment serves its own media with
 * zero URL configuration:
 *
 * - When storage is served locally (no `R2_PUBLIC_STORAGE_DOMAIN`, or e2e —
 *   see `isLocalStorageServing`): stream the object straight from the R2
 *   binding — local dev/e2e read local Miniflare state, so no remote R2 or
 *   credentials are needed. Fresh deploy-button workers take this path too.
 * - With a public CDN domain configured: redirect to it, so media bytes are
 *   served (and cached) by the R2 domain's edge instead of this worker, and
 *   rotating the domain only changes where the redirect points.
 */
export const Route = createFileRoute('/r2/$')({
  server: {
    handlers: {
      GET: ({ params, request }) =>
        serveStoredMedia(params._splat ?? '', request),
    },
  },
});
