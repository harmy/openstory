/**
 * Client-side upload utilities.
 * putToR2 uploads a file directly to R2 via presigned URL using XHR for progress.
 */

export function getFileKey(file: File): string {
  return `${file.name}-${file.lastModified}`;
}

/**
 * Upload a blob (or File) directly to R2 via the presigned/proxied PUT URL.
 *
 * Uses XHR rather than `fetch()` deliberately: fetch with a request body
 * stalls large uploads in Chrome (the request hangs at "Initial connection"
 * and never dispatches the body), whereas `xhr.send()` reliably streams it —
 * which is why every upload in the app goes through here. XHR also reports
 * real upload progress, which fetch can't. The body is streamed over the wire,
 * not duplicated, so there's no extra buffering beyond the blob the caller
 * already holds.
 */
export function putToR2(
  uploadUrl: string,
  file: Blob,
  contentType: string,
  onProgress?: (percent: number) => void,
  options?: { signal?: AbortSignal; timeoutMs?: number }
): Promise<void> {
  return new Promise((resolve, reject) => {
    const { signal, timeoutMs } = options ?? {};
    if (signal?.aborted) {
      reject(new DOMException('Upload aborted', 'AbortError'));
      return;
    }

    const xhr = new XMLHttpRequest();

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && onProgress) {
        const percent = Math.round((event.loaded / event.total) * 100);
        onProgress(percent);
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`R2 upload failed with status ${xhr.status}`));
      }
    };

    xhr.onerror = () => reject(new Error('Upload failed'));
    xhr.ontimeout = () =>
      reject(new Error(`Upload timed out after ${timeoutMs}ms`));

    if (signal) {
      xhr.onabort = () =>
        reject(new DOMException('Upload aborted', 'AbortError'));
      signal.addEventListener('abort', () => xhr.abort(), { once: true });
    }
    if (timeoutMs !== undefined) xhr.timeout = timeoutMs;

    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.send(file);
  });
}
