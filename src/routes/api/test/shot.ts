import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  createTestShot,
  getTestShot,
  getTestSequenceShots,
} from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const CreateShotSchema = z.object({
  sequenceId: z.string(),
  orderIndex: z.number(),
  thumbnailUrl: z.string().optional(),
  variantImageUrl: z.string().nullable().optional(),
  variantImageStatus: z
    .enum(['pending', 'generating', 'completed', 'failed'])
    .optional(),
});

export const Route = createFileRoute('/api/test/shot')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request }) => {
          const { sequenceId, orderIndex, ...options } = CreateShotSchema.parse(
            await request.json()
          );

          if (!sequenceId || typeof orderIndex !== 'number') {
            return Response.json(
              { error: 'sequenceId and orderIndex are required' },
              { status: 400 }
            );
          }

          const shot = await createTestShot(sequenceId, orderIndex, options);
          return Response.json(shot);
        },

        /**
         * GET /api/test/shot?id=...  -> single shot
         * GET /api/test/shot?sequenceId=... -> all shots for seq (for polling)
         */
        GET: async ({ request }) => {
          const url = new URL(request.url);
          const id = url.searchParams.get('id');
          const sequenceId = url.searchParams.get('sequenceId');

          if (id) {
            const shot = await getTestShot(id);
            if (!shot) {
              return Response.json({ error: 'not found' }, { status: 404 });
            }
            return Response.json(shot);
          }

          if (sequenceId) {
            const shots = await getTestSequenceShots(sequenceId);
            return Response.json(shots);
          }

          return Response.json(
            { error: 'id or sequenceId query param required' },
            { status: 400 }
          );
        },
      }),
  },
});
