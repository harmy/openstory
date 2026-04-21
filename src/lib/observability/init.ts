/**
 * Server-only tracing boot.
 *
 * `ensureObservability()` initialises the OTel tracer provider (Langfuse +
 * PostHog exporters) and the @tanstack/ai event bridge. Both inner init
 * functions are idempotent, so repeated calls are safe.
 *
 * The wrapper is a `createServerOnlyFn` so invoking it from client code
 * throws at runtime — callers must invoke it from inside a server-only
 * execution path (e.g. a `createMiddleware(...).server(...)` callback).
 */

import { createServerOnlyFn } from '@tanstack/react-start';

import { initAIEventBridge } from './ai-event-bridge';
import { initTracing } from './langfuse';

export const ensureObservability = createServerOnlyFn(() => {
  initTracing();
  initAIEventBridge();
});
