/**
 * Orchestrator for `POST /api/v1/scripts/enhance`. Resolves the public,
 * human-friendly input (style by ref, elements by URL) into the shared
 * {@link streamScriptEnhancement} generator, then frames its deltas as
 * Server-Sent Events.
 *
 *   resolve style → build EnhanceScriptInput → stream deltas as SSE
 *
 * Server-only (imports the AI stack via `@/functions/ai`); kept separate from
 * `enhance-input-schema.ts` so discovery/OpenAPI can import the schema without
 * pulling this in.
 */

import {
  type EnhanceScriptInput,
  streamScriptEnhancement,
} from '@/functions/ai';
import { toEnhanceInputs } from '@/lib/ai/enhance-inputs';
import { aspectRatioSchema } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import { handleApiError } from '@/lib/errors';
import { getLogger, toErrorPayload } from '@/lib/observability/logger';
import type { ApiEnhanceScriptInput } from './enhance-input-schema';
import { resolveStyle } from './resolve';

const logger = getLogger(['openstory', 'api-v1']);

export type EnhanceContext = {
  scopedDb: ScopedDb;
  user: { id: string };
  teamId: string;
};

/**
 * Turn the public enhance input into the shared enhancement generator. When a
 * style reference is given, it's resolved read-only (no library writes) so its
 * aesthetic recipe + identity (name/category/tags) and recommended aspect ratio
 * steer the rewrite — fed via the same `toEnhanceInputs` the UI and create flow
 * use, so all three enhance identically. Throws (→ JSON error) on an
 * unresolvable style reference; the returned generator defers billing and the
 * LLM call to its first `.next()`.
 */
export async function buildEnhanceGenerator(
  input: ApiEnhanceScriptInput,
  ctx: EnhanceContext
): Promise<AsyncGenerator<{ delta: string }>> {
  const style = input.style
    ? await resolveStyle(ctx.scopedDb, input.style)
    : undefined;

  const data: EnhanceScriptInput = {
    script: input.script,
    targetDuration: input.targetSeconds,
    aspectRatio:
      input.aspectRatio ??
      (style
        ? aspectRatioSchema.safeParse(style.defaultAspectRatio).data
        : undefined),
    // Caller-hosted element URLs go straight to the model (no ingest needed —
    // there's no sequence to persist them into); map url → the tempPublicUrl
    // field `toEnhanceInputs` reads.
    ...toEnhanceInputs({
      style,
      elements: input.elements?.map((el) => ({
        token: el.token,
        tempPublicUrl: el.url,
        description: el.description,
      })),
    }),
  };

  return streamScriptEnhancement(data, {
    scopedDb: ctx.scopedDb,
    userId: ctx.user.id,
    teamId: ctx.teamId,
  });
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Disable proxy buffering so deltas flush as they're produced.
  'X-Accel-Buffering': 'no',
} as const;

/**
 * Frame an already-started enhancement generator as an SSE stream. `first` is
 * the result of the caller's initial `gen.next()` — pulled before this is called
 * so pre-stream failures (billing, an unresolvable model) surface as a JSON
 * error with the right status, rather than a 200 stream that immediately errors.
 *
 * Wire format (matches the OpenAPI doc): each delta is an unnamed `data:` frame
 * `{ "delta": "…" }`; a terminal `event: done` frame carries the full
 * `{ "enhancedScript": "…" }`. A mid-stream failure (headers already sent)
 * becomes an `event: error` frame `{ code, message }`.
 */
export function enhanceSseResponse(
  first: IteratorResult<{ delta: string }>,
  rest: AsyncGenerator<{ delta: string }>
): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const data = (payload: unknown) =>
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(payload)}\n\n`)
        );
      const event = (name: string, payload: unknown) =>
        controller.enqueue(
          encoder.encode(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`)
        );

      let full = '';
      const push = (delta: string) => {
        if (!delta) return;
        full += delta;
        data({ delta });
      };

      try {
        if (!first.done) push(first.value.delta);
        for await (const chunk of rest) push(chunk.delta);
        event('done', { enhancedScript: full.trim() });
      } catch (err) {
        const handled = handleApiError(err);
        // Headers are already committed, so this can't become a JSON 500 — but
        // it must still be traceable. Mirror runApiV1Handler: log server-class
        // failures (incl. a post-success `deduct` throw, which lands here) with
        // the original stack/cause; the client only ever sees code/message.
        if (handled.statusCode >= 500) {
          logger.error(
            'api/v1 enhance stream failed mid-stream: {code} {message}',
            {
              code: handled.code,
              message: handled.message,
              err: toErrorPayload(err),
            }
          );
        }
        event('error', { code: handled.code, message: handled.message });
      } finally {
        controller.close();
      }
    },
    async cancel() {
      // Client disconnected — let the generator unwind (skips the final
      // billing deduction, matching the dashboard stream's behaviour). A
      // cleanup failure while unwinding would otherwise surface as an unhandled
      // rejection, so log and swallow it.
      try {
        await rest.return(undefined);
      } catch (err) {
        logger.warn('api/v1 enhance stream cancel: generator cleanup failed', {
          err: toErrorPayload(err),
        });
      }
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
