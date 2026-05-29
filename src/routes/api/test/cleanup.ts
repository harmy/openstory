import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  cleanTestData,
  cleanupTeamTestData,
  resetTestDatabase,
} from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const CleanupSchema = z.object({
  type: z.enum(['team', 'test-data', 'full-reset']),
  teamId: z.string().optional(),
});

export const Route = createFileRoute('/api/test/cleanup')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request }) => {
          const { type, teamId } = CleanupSchema.parse(await request.json());

          if (type === 'team') {
            if (!teamId) {
              return Response.json(
                { error: 'teamId is required for type=team' },
                { status: 400 }
              );
            }
            await cleanupTeamTestData(teamId);
          } else if (type === 'test-data') {
            await cleanTestData();
          } else if (type === 'full-reset') {
            await resetTestDatabase();
          }

          return Response.json({ success: true });
        },
      }),
  },
});
