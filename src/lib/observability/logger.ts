/**
 * LogTape configuration + helpers — the canonical logger for OpenStory.
 *
 * Server: emits one JSON line per record to console.log. Cloudflare Workers
 * Observability picks these up and forwards to PostHog Logs via the
 * dashboard-configured destination.
 *
 * Browser: forwards to posthog.captureLog when available. Falls back to a
 * pretty console in dev.
 *
 * Use:
 *   const logger = getLogger(['openstory', 'workflow', 'motion']);
 *   logger.info('step started', { workflowRunId, sceneId });
 */

import {
  configureSync,
  defaultConsoleFormatter,
  type ConsoleFormatter,
  getConsoleSink,
  getJsonLinesFormatter,
  getLogger,
  type LogLevel,
  type LogRecord,
  type Sink,
  type TextFormatter,
} from '@logtape/logtape';
// Pretty formatter for dev. Static ESM import — @logtape/pretty is marked
// `sideEffects: false`, so Vite tree-shakes it out of the prod worker bundle
// once `dev` resolves to `false` at build time (process.env.NODE_ENV is
// statically replaced). require() doesn't work for this ESM-only package in
// Workerd, which is what broke pretty output under `bun dev`.
import { getPrettyFormatter } from '@logtape/pretty';
import { redactByPattern, type RedactionPattern } from '@logtape/redaction';
import { z } from 'zod';
import { handleApiError, OpenStoryError } from '@/lib/errors';

const REDACT = '[REDACTED]';

/**
 * Redaction patterns for secrets that should never reach a log sink.
 * Ported from the previous src/lib/observability/structured-log.ts.
 * Each pattern MUST have the `g` flag (required by `@logtape/redaction`).
 */
const SECRET_PATTERNS: readonly RedactionPattern[] = [
  {
    pattern:
      /\b(sk|pk|fal|key|token|secret|password|bearer)[-_]?[a-zA-Z0-9\-_.]{16,}\b/gi,
    replacement: REDACT,
  },
  {
    pattern: /\b(postgres|mysql|redis|https?):\/\/[^\s"']+@[^\s"']+/gi,
    replacement: REDACT,
  },
  { pattern: /\b[A-Za-z0-9+/]{64,}={0,2}\b/g, replacement: REDACT },
  { pattern: /\bAKIA[A-Z0-9]{16}\b/g, replacement: REDACT },
  {
    pattern: /\b[A-Za-z0-9_-]{40}\b(?=.*(?:token|key|secret))/gi,
    replacement: REDACT,
  },
];

const isBrowser = (): boolean => typeof window !== 'undefined';
const isDevelopment = (): boolean => process.env.NODE_ENV !== 'production';

let configured = false;

/**
 * Configure LogTape. Idempotent — safe to call on hot-reload and from both
 * server entry (instrumentation.ts) and browser entry (ObservabilityProvider).
 */
export function configureLogging(): void {
  if (configured) return;
  configured = true;

  const dev = isDevelopment();
  const browser = isBrowser();
  const level: LogLevel = dev ? 'debug' : 'info';

  const sinks: Record<string, Sink> = browser
    ? buildBrowserSinks(dev)
    : buildServerSinks(dev);

  configureSync({
    sinks,
    loggers: [
      {
        category: ['openstory'],
        sinks: Object.keys(sinks),
        lowestLevel: level,
      },
      // Silence LogTape's own meta logger except for errors. Without this,
      // every dropped log record warning floods the console.
      {
        category: ['logtape', 'meta'],
        sinks: Object.keys(sinks),
        lowestLevel: 'error',
      },
    ],
  });
}

function buildServerSinks(dev: boolean): Record<string, Sink> {
  // `dev` is statically known at build time (via process.env.NODE_ENV
  // replacement), so the unused branch is dropped and only the live
  // formatter's dependency stays in the bundle.
  const formatter: TextFormatter = dev
    ? redactByPattern(
        // One clean pretty line per record.
        // - timestamp: 'time' → wall-clock per record (HH:MM:SS.sss) to help
        //   correlate LLM/workflow steps; concurrently's `dev:vite | ` prefix
        //   already anchors interleave order.
        // - properties: false → don't print the structured-field block. The
        //   noisy request/serverFn logs interpolate their values into the
        //   message via `{placeholder}`, so re-listing them is redundant; the
        //   prod JSON-lines sink (below) still keeps every field for PostHog.
        // - wordWrap: false → no hanging-indent continuation. `bun --parallel`
        //   (concurrently, e.g. `dev:all`) re-prefixes wrapped lines with
        //   `dev:vite | `, making the default auto-wrap ragged; let the
        //   terminal hard-wrap instead.
        getPrettyFormatter({
          timestamp: 'time',
          wordWrap: false,
          properties: false,
        }),
        SECRET_PATTERNS
      )
    : redactByPattern(getJsonLinesFormatter(), SECRET_PATTERNS);

  return { console: getConsoleSink({ formatter }) };
}

function buildBrowserSinks(dev: boolean): Record<string, Sink> {
  if (dev) {
    const consoleFormatter: ConsoleFormatter = defaultConsoleFormatter;
    return { console: getConsoleSink({ formatter: consoleFormatter }) };
  }

  // Production browser: ship to PostHog, plus pass warn/error through to
  // DevTools so SREs can still see failures when inspecting a live page.
  const passthroughFormatter: ConsoleFormatter = defaultConsoleFormatter;
  return {
    posthog: posthogBrowserSink,
    console: getConsoleSink({
      formatter: passthroughFormatter,
      levelMap: {
        trace: 'debug',
        debug: 'debug',
        info: 'log',
        warning: 'warn',
        error: 'error',
        fatal: 'error',
      },
    }),
  };
}

type PosthogCaptureLog = (input: {
  severity: LogLevel;
  body: string;
  attributes?: Record<string, unknown>;
}) => void;

type PosthogLike = {
  captureLog?: PosthogCaptureLog;
};

declare global {
  interface Window {
    posthog?: PosthogLike;
  }
}

function getBrowserPosthog(): PosthogLike | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = window.posthog;
  return value && typeof value.captureLog === 'function' ? value : undefined;
}

const posthogBrowserSink: Sink = (record: LogRecord): void => {
  const posthog = getBrowserPosthog();
  if (!posthog?.captureLog) return;

  posthog.captureLog({
    severity: record.level,
    body: redactString(renderMessage(record.message)),
    attributes: {
      category: record.category.join('.'),
      timestamp: record.timestamp,
      ...redactProperties(record.properties),
    },
  });
};

function renderMessage(message: readonly unknown[]): string {
  return message
    .map((part) =>
      typeof part === 'string'
        ? part
        : (() => {
            try {
              return JSON.stringify(part);
            } catch {
              return String(part);
            }
          })()
    )
    .join('');
}

function redactString(input: string): string {
  let out = input;
  for (const { pattern, replacement } of SECRET_PATTERNS) {
    out = out.replaceAll(
      pattern,
      typeof replacement === 'string' ? replacement : REDACT
    );
  }
  return out;
}

function redactProperties(
  props: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    out[key] = typeof value === 'string' ? redactString(value) : value;
  }
  return out;
}

// ============================================================================
// Public helpers
// ============================================================================

export { getLogger };

const apiLoggerRoot = getLogger(['openstory', 'api']);

const API_SLOW_THRESHOLD_MS = 500;
const API_VERY_SLOW_THRESHOLD_MS = 2000;

type ApiHandlerArgs = {
  request: Request;
  params: Record<string, string>;
};

/**
 * Wrap an API route handler with structured request logging. Logs at:
 *   - error: non-2xx responses and thrown handlers (always)
 *   - warn:  successful requests slower than 2s
 *   - info:  successful requests slower than 500ms
 *   - debug: fast successful requests (kept silent at INFO+ to avoid noise)
 *
 * Replaces the legacy `withApiLogging` helper. Headlines include
 * method/path/status/duration so they're readable without expanding fields.
 */
export function logApiRequest(
  routeName: string,
  handler: (args: ApiHandlerArgs) => Promise<Response>
): (args: ApiHandlerArgs) => Promise<Response> {
  const logger = apiLoggerRoot.getChild(routeName);

  return async (args) => {
    const start = performance.now();
    const { request } = args;
    const contentLength = request.headers.get('content-length');
    const method = request.method;
    const path = new URL(request.url).pathname;
    const baseCtx = {
      route: routeName,
      method,
      path,
      contentLength: contentLength ? Number(contentLength) : undefined,
    };

    try {
      const response = await handler(args);
      const durationMs = Math.round(performance.now() - start);
      const status = response.status;

      if (status >= 400) {
        const errorDetail = await parseErrorResponse(response);
        logger.error(
          'api {method} {path} {status} ({errCode}) {durationMs}ms',
          {
            ...baseCtx,
            durationMs,
            status,
            errCode: errorDetail.code,
            errMessage: errorDetail.message,
            err: errorDetail,
          }
        );
      } else if (durationMs >= API_VERY_SLOW_THRESHOLD_MS) {
        logger.warn('api {method} {path} {status} very slow {durationMs}ms', {
          ...baseCtx,
          durationMs,
          status,
        });
      } else if (durationMs >= API_SLOW_THRESHOLD_MS) {
        logger.info('api {method} {path} {status} slow {durationMs}ms', {
          ...baseCtx,
          durationMs,
          status,
        });
      } else {
        logger.debug('api {method} {path} {status} {durationMs}ms', {
          ...baseCtx,
          durationMs,
          status,
        });
      }

      return response;
    } catch (error) {
      const durationMs = Math.round(performance.now() - start);
      const handled = handleApiError(error);
      logger.error('api {method} {path} threw: {errCode} {errMessage}', {
        ...baseCtx,
        durationMs,
        errCode: handled.code,
        errMessage: handled.message,
        err: {
          code: handled.code,
          message: handled.message,
          statusCode: handled.statusCode,
        },
      });
      throw error;
    }
  };
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

async function parseErrorResponse(
  response: Response
): Promise<{ code: string; message: string; statusCode: number }> {
  try {
    const cloned = response.clone();
    const text = await cloned.text();
    const jsonResult = errorBodySchema.safeParse(safeJsonParse(text));
    if (jsonResult.success) {
      const body = jsonResult.data;
      return {
        code: body.error?.code ?? `HTTP_${response.status}`,
        message: body.error?.message ?? body.message ?? response.statusText,
        statusCode: response.status,
      };
    }
    const message =
      text.length > 0
        ? text.length > 200
          ? `${text.slice(0, 200)}…`
          : text
        : response.statusText;
    return {
      code: `HTTP_${response.status}`,
      message,
      statusCode: response.status,
    };
  } catch {
    return {
      code: `HTTP_${response.status}`,
      message: response.statusText,
      statusCode: response.status,
    };
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * A serialized error plus its full `cause` chain. The structured `{ err }` we
 * pass to `logger.error` only captures `name`/`message`/`stack` of the top
 * error — the `.cause` link (e.g. the raw D1 driver error that
 * `DrizzleQueryError` wraps) is dropped. This walks the chain so the underlying
 * reason is logged. Crucial because `.cause` is also stripped once an error
 * crosses a Cloudflare Workflows step boundary, so logging the chain at the
 * point it's thrown is the only way to observe it (issue #864).
 */
export type SerializedError = {
  name?: string;
  message: string;
  stack?: string;
  cause?: SerializedError | string;
};

export function serializeError(
  error: unknown,
  maxDepth = 4
): SerializedError | string {
  if (error instanceof Error) {
    const out: SerializedError = { name: error.name, message: error.message };
    if (error.stack) out.stack = error.stack;
    if (error.cause != null && maxDepth > 0) {
      out.cause = serializeError(error.cause, maxDepth - 1);
    }
    return out;
  }
  if (typeof error === 'string') return error;
  return String(error);
}

/**
 * Standardised error payload for logger.error('...', { err }).
 * Normalises OpenStoryError vs unknown into a stable shape, including the
 * `.cause` chain so a wrapped driver error (e.g. D1 under `DrizzleQueryError`)
 * is never silently dropped.
 */
export function toErrorPayload(error: unknown): {
  code: string;
  message: string;
  statusCode?: number;
  stack?: string;
  cause?: SerializedError | string;
} {
  const cause =
    error instanceof Error && error.cause != null
      ? serializeError(error.cause)
      : undefined;
  if (error instanceof OpenStoryError) {
    return {
      code: error.code,
      message: error.message,
      statusCode: error.statusCode,
      stack: error.stack,
      cause,
    };
  }
  if (error instanceof Error) {
    return {
      code: 'UNKNOWN',
      message: error.message,
      stack: error.stack,
      cause,
    };
  }
  return { code: 'UNKNOWN', message: String(error) };
}

type WorkflowContext = {
  workflowRunId?: string;
  userId?: string;
  teamId?: string;
};

/**
 * Get a child logger scoped to a workflow with run/user/team context bound.
 * Use at the top of each workflow definition:
 *
 *   const logger = getWorkflowLogger('motion-prompt-scene', { workflowRunId: context.workflowRunId });
 */
export function getWorkflowLogger(
  workflowName: string,
  context: WorkflowContext = {}
) {
  return getLogger(['openstory', 'workflow', workflowName]).with(context);
}
