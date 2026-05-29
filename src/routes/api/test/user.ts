import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { cleanupTestUser, createTestUser } from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const DeleteUserSchema = z.object({
  userId: z.string(),
  teamId: z.string(),
});

export const Route = createFileRoute('/api/test/user')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        /**
         * POST /api/test/user
         */
        POST: async ({ request }) => {
          let body: { name?: string } = {};
          try {
            body = await request.json();
          } catch {
            // ok, use defaults
          }

          const created = await createTestUser({ name: body.name });
          return Response.json(created);
        },

        /**
         * DELETE /api/test/user
         */
        DELETE: async ({ request }) => {
          const { userId, teamId } = DeleteUserSchema.parse(
            await request.json()
          );

          if (!userId || !teamId) {
            return Response.json(
              { error: 'userId and teamId are required' },
              { status: 400 }
            );
          }

          await cleanupTestUser(userId, teamId);
          return Response.json({ success: true });
        },
      }),
  },
});
