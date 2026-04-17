/**
 * Structured JSON log emitter for Cloudflare Workers.
 * Outputs JSON to console.log so Cloudflare captures it in workers_trace_events,
 * and Logpush sends it unredacted to R2.
 * Warn/error logs are also sent to PostHog as `server_log` events.
 */

import { getPostHogClient } from '@/lib/posthog-server';

type StructuredLog = {
  level: 'info' | 'warn' | 'error';
  source: 'serverFn' | 'api' | 'workflow';
  name: string;
  method?: string;
  path?: string;
  durationMs: number;
  contentLength?: number;
  userId?: string;
  status: 'ok' | 'error';
  error?: {
    code: string;
    message: string;
    statusCode?: number;
  };
};

const REDACT = '[REDACTED]';

const SECRET_PATTERNS = [
  // API keys / tokens (common prefixes and generic patterns)
  /\b(sk|pk|fal|key|token|secret|password|bearer)[-_]?[a-zA-Z0-9\-_.]{16,}\b/gi,
  // Connection strings (postgres, mysql, redis, libsql, etc.)
  /\b(postgres|mysql|redis|libsql|https?):\/\/[^\s"']+@[^\s"']+/gi,
  // Base64 blobs (>64 chars likely a credential or payload, not useful in logs)
  /\b[A-Za-z0-9+/]{64,}={0,2}\b/g,
  // AWS-style keys
  /\bAKIA[A-Z0-9]{16}\b/g,
  // Cloudflare API tokens
  /\b[A-Za-z0-9_-]{40}\b(?=.*(?:token|key|secret))/gi,
];

function redactSecrets(message: string): string {
  let result = message;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, REDACT);
  }
  return result;
}

const LEVEL_STYLES: Record<
  StructuredLog['level'],
  { label: string; color: string }
> = {
  info: { label: 'INFO', color: '\x1b[36m' }, // cyan
  warn: { label: 'WARN', color: '\x1b[33m' }, // yellow
  error: { label: 'ERR!', color: '\x1b[31m' }, // red
};
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';

function emitDevLog(log: StructuredLog): void {
  const { label, color } = LEVEL_STYLES[log.level];
  const method = log.method ?? '';
  const path = log.path ?? log.name;
  const ms = `${DIM}${log.durationMs}ms${RESET}`;

  let line = `${color}${label}${RESET} ${method} ${path} ${ms}`;

  if (log.error) {
    line += ` ${color}${log.error.code}: ${log.error.message}${RESET}`;
  }

  const logFn =
    log.level === 'error'
      ? console.error
      : log.level === 'warn'
        ? console.warn
        : console.log;
  logFn(line);
}

export function emitLog(log: StructuredLog): void {
  if (log.error?.message) {
    log = {
      ...log,
      error: {
        ...log.error,
        message: redactSecrets(log.error.message),
      },
    };
  }

  if (process.env.NODE_ENV === 'development') {
    emitDevLog(log);
    return;
  }

  console.log(JSON.stringify(log));

  if (log.level === 'warn' || log.level === 'error') {
    const posthog = getPostHogClient();
    if (posthog) {
      posthog.capture({
        distinctId: log.userId ?? 'system',
        event: 'server_log',
        properties: {
          level: log.level,
          source: log.source,
          name: log.name,
          method: log.method,
          path: log.path,
          durationMs: log.durationMs,
          status: log.status,
          ...(log.error && {
            errorCode: log.error.code,
            errorMessage: log.error.message,
          }),
        },
      });
    }
  }
}
