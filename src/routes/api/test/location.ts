import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  cleanupLocationById,
  cleanupLocationByName,
  cleanupTestLocations,
  createTestLocation,
  getSystemLocationByName,
} from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const CreateLocationSchema = z.object({
  teamId: z.string(),
  name: z.string(),
});

const DeleteLocationSchema = z.object({
  teamId: z.string().optional(),
  locationId: z.string().optional(),
  name: z.string().optional(),
});

export const Route = createFileRoute('/api/test/location')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request }) => {
          const { teamId, name } = CreateLocationSchema.parse(
            await request.json()
          );

          if (!teamId || !name) {
            return Response.json(
              { error: 'teamId and name are required' },
              { status: 400 }
            );
          }

          const created = await createTestLocation(teamId, name);
          return Response.json(created);
        },

        /**
         * DELETE /api/test/location
         * Supports: {teamId} (all for team), {locationId}, or {teamId, name}
         */
        DELETE: async ({ request }) => {
          const body = DeleteLocationSchema.parse(await request.json());

          if (body.teamId && !body.name && !body.locationId) {
            await cleanupTestLocations(body.teamId);
          } else if (body.locationId) {
            await cleanupLocationById(body.locationId);
          } else if (body.teamId && body.name) {
            await cleanupLocationByName(body.teamId, body.name);
          } else {
            return Response.json(
              {
                error:
                  'teamId (for all) or locationId or (teamId + name) required',
              },
              { status: 400 }
            );
          }

          return Response.json({ success: true });
        },

        /**
         * GET /api/test/location?name=...
         * Used for system (public) location lookup by name.
         */
        GET: async ({ request }) => {
          const url = new URL(request.url);
          const name = url.searchParams.get('name');
          if (!name) {
            return Response.json(
              { error: 'name query param required' },
              { status: 400 }
            );
          }
          try {
            const loc = await getSystemLocationByName(name);
            return Response.json(loc);
          } catch (err) {
            return Response.json(
              { error: err instanceof Error ? err.message : 'not found' },
              { status: 404 }
            );
          }
        },
      }),
  },
});
