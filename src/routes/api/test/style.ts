import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { createTestStyle } from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const CreateStyleSchema = z.object({
  teamId: z.string(),
});

export const Route = createFileRoute('/api/test/style')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request }) => {
          const { teamId } = CreateStyleSchema.parse(await request.json());
          if (!teamId) {
            return Response.json(
              { error: 'teamId is required' },
              { status: 400 }
            );
          }

          const style = await createTestStyle(teamId);
          return Response.json(style);
        },
      }),
  },
});
