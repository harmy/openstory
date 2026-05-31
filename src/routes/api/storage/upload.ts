import { uploadFile } from '#storage';
import { authRequestMiddleware } from '@/functions/middleware';
import { resolveUserTeam } from '@/lib/db/scoped';
import { handleApiError } from '@/lib/errors';
import { STORAGE_BUCKETS, type StorageBucket } from '@/lib/storage/buckets';
import { createFileRoute } from '@tanstack/react-router';

const bucketByName = new Map<string, StorageBucket>(
  Object.values(STORAGE_BUCKETS).map((b) => [b, b])
);

export const Route = createFileRoute('/api/storage/upload')({
  server: {
    middleware: [authRequestMiddleware],
    handlers: {
      PUT: async ({ request, context }) => {
        try {
          const team = await resolveUserTeam(context.user.id);
          if (!team) {
            return Response.json(
              { success: false, error: 'No team found' },
              { status: 403 }
            );
          }

          const url = new URL(request.url);
          const bucket = url.searchParams.get('bucket');
          const path = url.searchParams.get('path');
          const contentType = url.searchParams.get('contentType');

          if (!bucket || !path || !contentType) {
            return Response.json(
              {
                success: false,
                error:
                  'Missing required query params: bucket, path, contentType',
              },
              { status: 400 }
            );
          }

          const validBucket = bucketByName.get(bucket);
          if (!validBucket) {
            return Response.json(
              { success: false, error: `Invalid bucket: ${bucket}` },
              { status: 400 }
            );
          }

          if (!path.includes(team.teamId)) {
            return Response.json(
              { success: false, error: 'Path must contain your team ID' },
              { status: 403 }
            );
          }

          const body = request.body;
          if (!body) {
            return Response.json(
              { success: false, error: 'Request body is empty' },
              { status: 400 }
            );
          }

          // workerd's R2 binding rejects ReadableStreams without a known
          // length. The browser sends Content-Length (the body is a Blob),
          // but once `request.body` has been routed through TanStack Start
          // the length link is lost — so we re-establish it explicitly via
          // FixedLengthStream. See issue #738. Streaming (rather than
          // buffering) keeps the route within the 128MB Worker memory limit
          // for large exports.
          const contentLengthHeader = request.headers.get('content-length');
          const contentLength = contentLengthHeader
            ? Number.parseInt(contentLengthHeader, 10)
            : Number.NaN;

          if (!Number.isFinite(contentLength) || contentLength <= 0) {
            return Response.json(
              {
                success: false,
                error: 'Content-Length header required for upload',
              },
              { status: 411 }
            );
          }

          const fixedLength = new FixedLengthStream(contentLength);
          body.pipeTo(fixedLength.writable).catch(() => {
            // Pipe errors (client disconnect, length mismatch) surface
            // through the readable side and reject the r2.put() below,
            // which the outer catch turns into a 5xx via handleApiError.
          });

          await uploadFile(validBucket, path, fixedLength.readable, {
            contentType,
          });

          return Response.json({ success: true });
        } catch (error) {
          const handledError = handleApiError(error);
          return Response.json(
            { success: false, error: handledError.toJSON() },
            { status: handledError.statusCode }
          );
        }
      },
    },
  },
});
