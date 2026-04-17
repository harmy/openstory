/**
 * Extract a meaningful error message from fal.ai API errors.
 *
 * The `@fal-ai/client` throws `ApiError`/`ValidationError` with the full
 * response body on `error.body`, but `.message` only contains
 * `body.message || statusText` — which for 422s is just "Unprocessable Entity".
 *
 * The actual detail lives in `error.body.detail` (FastAPI/Pydantic format).
 */
export function extractFalErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);

  // Check for fal-ai client error shape: { body: { detail: ... }, status: number }
  const falError = error as Error & {
    body?: { detail?: Array<{ msg: string; type?: string }> | string };
    status?: number;
  };

  if (falError.body?.detail) {
    const { detail } = falError.body;

    if (typeof detail === 'string') {
      return detail;
    }

    if (Array.isArray(detail) && detail.length > 0) {
      // Join all detail messages (usually just one)
      return detail.map((d) => d.msg).join('; ');
    }
  }

  return error.message;
}
