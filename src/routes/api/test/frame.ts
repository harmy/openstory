import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import {
  createTestFrame,
  getTestFrame,
  getTestSequenceFrames,
} from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const CreateFrameSchema = z.object({
  sequenceId: z.string(),
  orderIndex: z.number(),
  thumbnailUrl: z.string().optional(),
  variantImageUrl: z.string().nullable().optional(),
  variantImageStatus: z
    .enum(['pending', 'generating', 'completed', 'failed'])
    .optional(),
});

export const Route = createFileRoute('/api/test/frame')({
  server: {
    middleware: [testOnlyGuard],
    handlers: ({ createHandlers }) =>
      createHandlers({
        POST: async ({ request }) => {
          const { sequenceId, orderIndex, ...options } =
            CreateFrameSchema.parse(await request.json());

          if (!sequenceId || typeof orderIndex !== 'number') {
            return Response.json(
              { error: 'sequenceId and orderIndex are required' },
              { status: 400 }
            );
          }

          const frame = await createTestFrame(sequenceId, orderIndex, options);
          return Response.json(frame);
        },

        /**
         * GET /api/test/frame?id=...  -> single frame
         * GET /api/test/frame?sequenceId=... -> all frames for seq (for polling)
         */
        GET: async ({ request }) => {
          const url = new URL(request.url);
          const id = url.searchParams.get('id');
          const sequenceId = url.searchParams.get('sequenceId');

          if (id) {
            const frame = await getTestFrame(id);
            if (!frame) {
              return Response.json({ error: 'not found' }, { status: 404 });
            }
            return Response.json(frame);
          }

          if (sequenceId) {
            const frames = await getTestSequenceFrames(sequenceId);
            return Response.json(frames);
          }

          return Response.json(
            { error: 'id or sequenceId query param required' },
            { status: 400 }
          );
        },
      }),
  },
});
