/**
 * GET /api/v1/openapi.json — the machine-readable OpenAPI 3.1 spec.
 *
 * Built from the same Zod schema the create endpoint validates against, so the
 * spec can't drift from the runtime contract. Deliberately unauthenticated (like
 * the root) so tooling can fetch it before a key is wired up.
 */

import { buildOpenApiDocument } from '@/lib/api-v1/openapi';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/openapi.json')({
  server: {
    handlers: {
      GET: async () =>
        new Response(JSON.stringify(buildOpenApiDocument()), {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
          },
        }),
    },
  },
});
