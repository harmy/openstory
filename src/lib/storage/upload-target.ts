/**
 * Shared validation + authorization for storage upload endpoints.
 *
 * Both the single-shot `/api/storage/upload` route and the multipart routes
 * accept the destination as query params (bucket, path, contentType) and must
 * enforce the same team-scoping rule: the path has to contain the caller's
 * team id, so one team can't upload into another team's prefix. Keeping this
 * in one place avoids the security check drifting between routes.
 */

import { resolveUserTeam } from '@/lib/db/scoped';
import { STORAGE_BUCKETS, type StorageBucket } from './buckets';

const bucketByName = new Map<string, StorageBucket>(
  Object.values(STORAGE_BUCKETS).map((b) => [b, b])
);

export type UploadTarget = {
  bucket: StorageBucket;
  path: string;
  contentType: string;
};

type Resolved =
  | { ok: true; target: UploadTarget }
  | { ok: false; response: Response };

const fail = (error: string, status: number): Resolved => ({
  ok: false,
  response: Response.json({ success: false, error }, { status }),
});

/**
 * Resolve and authorize the upload target from request query params. Returns
 * either the validated target or a ready-to-return error Response.
 *
 * `contentType` defaults to `application/octet-stream` (callers that require an
 * explicit type, like the single upload, should check it themselves).
 */
export async function resolveUploadTarget(
  request: Request,
  userId: string
): Promise<Resolved> {
  const team = await resolveUserTeam(userId);
  if (!team) return fail('No team found', 403);

  const url = new URL(request.url);
  const bucket = url.searchParams.get('bucket');
  const path = url.searchParams.get('path');
  const contentType =
    url.searchParams.get('contentType') ?? 'application/octet-stream';

  if (!bucket || !path) {
    return fail('Missing required query params: bucket, path', 400);
  }

  const validBucket = bucketByName.get(bucket);
  if (!validBucket) return fail(`Invalid bucket: ${bucket}`, 400);

  // Anchor the team-scope check. A bare substring test (`path.includes(teamId)`)
  // is bypassable: an attacker could put their own team id in the filename and
  // still write into another team's prefix (e.g.
  // `teams/<victim>/…/<myTeamId>.mp4`). Instead require the team id to be the
  // *leading owner segment* — segment 0, or segment 1 when the path is under a
  // `teams/` prefix (exports use `teams/<id>/…`; talent/location/element use
  // `<id>/…`) — and reject traversal / empty segments.
  if (path.startsWith('/') || path.includes('//') || path.includes('..')) {
    return fail('Invalid upload path', 400);
  }
  const segments = path.split('/');
  const ownerSegment = segments[0] === 'teams' ? segments[1] : segments[0];
  if (ownerSegment !== team.teamId) {
    return fail('Path must be within your team prefix', 403);
  }

  return { ok: true, target: { bucket: validBucket, path, contentType } };
}
