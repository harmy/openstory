/**
 * Structured logging wrapper for API route handlers.
 * Wraps a handler to emit structured JSON logs with timing, status, and error details.
 */

import { handleApiError } from '@/lib/errors';
import { z } from 'zod';
import { emitLog } from './structured-log';

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const errorBodySchema = z.object({
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
  message: z.string().optional(),
});

type ApiHandlerArgs = {
  request: Request;
  params: Record<string, string>;
};

export function withApiLogging(
  routeName: string,
  handler: (args: ApiHandlerArgs) => Promise<Response>
): (args: ApiHandlerArgs) => Promise<Response> {
  return async (args) => {
    const start = performance.now();
    const { request } = args;
    const contentLength = request.headers.get('content-length');
    const path = new URL(request.url).pathname;

    try {
      const response = await handler(args);
      const durationMs = Math.round(performance.now() - start);
      const isError = response.status >= 400;

      let errorDetail:
        | { code: string; message: string; statusCode?: number }
        | undefined;
      if (isError) {
        try {
          const cloned = response.clone();
          const text = await cloned.text();
          let message = response.statusText;

          // Try JSON first, fall back to raw text
          const jsonResult = errorBodySchema.safeParse(safeJsonParse(text));
          if (jsonResult.success) {
            const body = jsonResult.data;
            message = body.error?.message ?? body.message ?? message;
          } else if (text.length > 0) {
            // Use raw text (truncated) for non-JSON error bodies
            message = text.length > 200 ? `${text.slice(0, 200)}…` : text;
          }

          errorDetail = {
            code: jsonResult.success
              ? (jsonResult.data.error?.code ?? `HTTP_${response.status}`)
              : `HTTP_${response.status}`,
            message,
            statusCode: response.status,
          };
        } catch {
          errorDetail = {
            code: `HTTP_${response.status}`,
            message: response.statusText,
            statusCode: response.status,
          };
        }
      }

      emitLog({
        level: isError ? 'error' : 'info',
        source: 'api',
        name: routeName,
        method: request.method,
        path,
        durationMs,
        contentLength: contentLength ? Number(contentLength) : undefined,
        status: isError ? 'error' : 'ok',
        error: errorDetail,
      });

      return response;
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      const handled = handleApiError(error);

      emitLog({
        level: 'error',
        source: 'api',
        name: routeName,
        method: request.method,
        path,
        durationMs,
        contentLength: contentLength ? Number(contentLength) : undefined,
        status: 'error',
        error: {
          code: handled.code,
          message: handled.message,
          statusCode: handled.statusCode,
        },
      });

      throw error;
    }
  };
}
