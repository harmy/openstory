import { fal } from '@fal-ai/client';

const FAL_HOSTS = new Set([
  'fal.run',
  'queue.fal.run',
  'rest.fal.ai',
  'rest.alpha.fal.ai',
  'gateway.fal.ai',
]);

let configured = false;

/**
 * Routes server-side fal.ai traffic through a proxy when FAL_PROXY_URL is set.
 *
 * fal-client's built-in `proxyUrl` only activates in the browser — see
 * @fal-ai/client/src/middleware.ts (`withProxy` no-ops when `window` is
 * undefined). Workflows run server-side, so we install a `requestMiddleware`
 * that rewrites fal hosts to the proxy origin while preserving the original
 * pathname. The proxy receives the original host via `x-fal-target-host`.
 */
export function configureFalProxyFromEnv(): void {
  if (configured) return;
  const proxyUrl = process.env.FAL_PROXY_URL;
  if (!proxyUrl) return;

  const proxy = new URL(proxyUrl);

  fal.config({
    requestMiddleware: async (request) => {
      const original = new URL(request.url);
      if (!FAL_HOSTS.has(original.hostname)) return request;

      const rewritten = new URL(proxy.toString());
      rewritten.pathname =
        proxy.pathname.replace(/\/$/, '') + original.pathname;
      rewritten.search = original.search;

      return {
        ...request,
        url: rewritten.toString(),
        headers: {
          ...request.headers,
          'x-fal-target-host': original.hostname,
        },
      };
    },
  });

  configured = true;
}
