/**
 * Upload a merged MP4 Blob to R2 using a presigned PUT URL (S3 deployments)
 * or the same-origin /api/storage/upload proxy (Cloudflare Workers).
 *
 * The shape of `uploadUrl` is provided by the server function
 * `requestMergedUploadUrlFn`, which delegates to `getSignedUploadUrl`.
 */

export async function uploadMergedBlob(args: {
  blob: Blob;
  uploadUrl: string;
  contentType: string;
  signal?: AbortSignal;
}): Promise<void> {
  const { blob, uploadUrl, contentType, signal } = args;

  const response = await fetch(uploadUrl, {
    method: 'PUT',
    body: blob,
    headers: { 'Content-Type': contentType },
    signal,
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(
      `Upload failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`
    );
  }
}
