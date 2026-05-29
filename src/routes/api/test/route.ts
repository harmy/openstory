import { createFileRoute } from '@tanstack/react-router';
import { createMiddleware } from '@tanstack/react-start';
import { getEnv } from '#env';

/**
 * Guard middleware for all test-only API endpoints.
 *
 * This is the single source of truth for "these routes only exist
 * when E2E_TEST=true".
 *
 * Uses getEnv() so the value is read from the Cloudflare Workers env
 * (populated from wrangler.jsonc [env.test].vars when CLOUDFLARE_ENV=test,
 * which is set by the Playwright webServer config and CI).
 */
export const testOnlyGuard = createMiddleware().server(async ({ next }) => {
  if (getEnv().E2E_TEST !== 'true') {
    return new Response('Not Found', { status: 404 });
  }
  return next();
});

/**
 * Parent route definition for the /api/test group.
 *
 * We keep this as a normal (non-pathless) directory so the URLs remain
 * /api/test/user, /api/test/talent, etc. (we want "test" visible in the path).
 *
 * Per the server-routes docs, pathless layouts (`_something`) are the
 * mechanism for applying middleware to a *group* of routes. However,
 * using `_test` here would make the "test" segment pathless, resulting in
 * public URLs like /api/user instead of /api/test/user — which we don't want.
 *
 * Therefore the pragmatic approach is:
 * - Define the single `testOnlyGuard` here (good for comments + one source of truth)
 * - Explicitly attach `middleware: [testOnlyGuard]` on each leaf route in this folder.
 *
 * This matches the style shown throughout the TanStack Start server routes
 * and middleware documentation.
 */
export const Route = createFileRoute('/api/test')({
  server: {
    middleware: [testOnlyGuard],
  },
});
