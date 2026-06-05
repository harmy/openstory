/**
 * GET /api/v1 — the API root / self-description.
 *
 * Returns an MCP-style `instructions` narrative plus the request JSON Schema and
 * a HAL `_links` catalog, so an agent can learn the whole API from one call.
 * Deliberately unauthenticated: discovery should work before a caller has a key,
 * so the narrative can explain how to get one.
 */

import { runApiV1Handler } from '@/lib/api-v1/errors';
import { buildRootDocument } from '@/lib/api-v1/discovery';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/api/v1/')({
  server: {
    handlers: {
      GET: async () =>
        runApiV1Handler(async () => Response.json(buildRootDocument())),
    },
  },
});
