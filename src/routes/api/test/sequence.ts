import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  cleanupSequenceById,
  cleanupTestSequences,
  createTestSequence,
  getTestSequenceStatus,
} from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const CreateSequenceSchema = z.object({
  teamId: z.string(),
  userId: z.string(),
  title: z.string().optional(),
});

export const Route = createFileRoute('/api/test/sequence')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        /**
         * POST /api/test/sequence
         */
        POST: async ({ request }) => {
          const { teamId, userId, title } = CreateSequenceSchema.parse(
            await request.json()
          );

          if (!teamId || !userId) {
            return Response.json(
              { error: 'teamId and userId are required' },
              { status: 400 }
            );
          }

          const created = await createTestSequence(teamId, userId, title);
          return Response.json(created);
        },

        /**
         * DELETE /api/test/sequence
         */
        DELETE: async ({ request }) => {
          const body = z
            .object({
              teamId: z.string().optional(),
              sequenceId: z.string().optional(),
              styleId: z.string().optional(),
            })
            .parse(await request.json());

          if (body.teamId) {
            await cleanupTestSequences(body.teamId);
          } else if (body.sequenceId && body.styleId) {
            await cleanupSequenceById(body.sequenceId, body.styleId);
          } else {
            return Response.json(
              { error: 'teamId or (sequenceId + styleId) required' },
              { status: 400 }
            );
          }

          return Response.json({ success: true });
        },

        /**
         * GET /api/test/sequence?sequenceId=... -> music status for polling
         */
        GET: async ({ request }) => {
          const url = new URL(request.url);
          const sequenceId = url.searchParams.get('sequenceId');
          if (!sequenceId) {
            return Response.json(
              { error: 'sequenceId query param required' },
              { status: 400 }
            );
          }
          const status = await getTestSequenceStatus(sequenceId);
          return Response.json(status);
        },
      }),
  },
});
