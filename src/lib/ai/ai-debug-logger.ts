/**
 * @tanstack/ai debug logger for local Workerd dev.
 *
 * The default `ConsoleLogger` dumps each category's payload via
 * `console.dir(meta, { depth: null, colors: true })` — Node `util.inspect`
 * options that Workerd's console ignores, so the bodies never reach the
 * `bun dev` terminal (you get the `[tanstack-ai:…]` headlines but no content).
 * This logger serializes `meta` with `JSON.stringify` through plain
 * `console.log`, which Workerd surfaces.
 *
 * Usage: pass `debug: { logger: aiDebugLogger }` on any `chat()` /
 * `callLLMStream` call (instead of `debug: true`) to see full request /
 * response / RUN_ERROR payloads.
 */

import type { Logger } from '@tanstack/ai';

function safeStringify(meta: Record<string, unknown>): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(
      meta,
      (_key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
        }
        return value;
      },
      2
    );
  } catch (err) {
    return `[unserializable meta: ${err instanceof Error ? err.message : String(err)}]`;
  }
}

function log(message: string, meta?: Record<string, unknown>): void {
  const line =
    meta === undefined ? message : `${message}\n${safeStringify(meta)}`;
  // Intentional console.log: this bridge exists precisely because Workerd
  // renders console.log but NOT the default ConsoleLogger's console.dir. LogTape
  // isn't used — its pretty sink hides `meta` unless `properties: true`, and the
  // JSON braces would break LogTape's `{placeholder}` message interpolation.
  // oxlint-disable-next-line no-console
  console.log(line);
}

export const aiDebugLogger: Logger = {
  debug: log,
  info: log,
  warn: log,
  error: log,
};
