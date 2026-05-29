/**
 * Environment utility functions for checking feature availability
 * based on environment variables and deployment context.
 *
 * IMPORTANT: All functions use lazy evaluation to support Cloudflare Workers
 * where process.env is only populated at request time.
 */

import { getEnv } from '#env';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';

/**
 * Platform detection
 */
type DeploymentPlatform =
  | 'cloudflare'
  | 'vercel'
  | 'railway'
  | 'local'
  | 'unknown';

/**
 * Detect which platform the app is running on
 */
export function getDeploymentPlatform(): DeploymentPlatform {
  const env = getEnv();
  if (env.CF_PAGES) {
    return 'cloudflare';
  }
  if (env.VERCEL) {
    return 'vercel';
  }
  if (env.RAILWAY_ENVIRONMENT) {
    return 'railway';
  }
  if (env.NODE_ENV === 'development') {
    return 'local';
  }
  return 'unknown';
}

/**
 * Server-side application URL
 * Used by Better Auth, QStash webhooks, and internal API calls
 * Lazily evaluated to support Cloudflare Workers
 */
export function getServerAppUrl(request: Request): string {
  const url = new URL(request.url);
  return url.origin;
}

/**
 * Get production deployment app URL
 * Used for OAuth redirects on preview branches.
 * If VITE_APP_URL env var is set, use that as the canonical production URL.
 * Otherwise fall back to the request origin.
 */
export function getProductionDeploymentAppUrl(request: Request): string {
  const envAppUrl = getEnv().VITE_APP_URL;
  if (envAppUrl) {
    return envAppUrl.replace(/\/$/, '');
  }

  return getServerAppUrl(request);
}

export function isProductionDeployment(request: Request): boolean {
  return (
    !isLocalDevelopment() &&
    getProductionDeploymentAppUrl(request) === getServerAppUrl(request)
  );
}

/**
 * Check if this is a preview deployment.
 * Preview if: VITE_APP_URL is explicitly empty, or VITE_APP_URL doesn't match the request origin.
 */
export function isPreviewDeployment(request: Request): boolean {
  if (isLocalDevelopment()) return false;

  const envAppUrl = getEnv().VITE_APP_URL;

  // VITE_APP_URL explicitly set to empty string or not set = preview branch
  if (!envAppUrl) return true;

  // Otherwise check VITE_APP_URL to see if it's a PR url
  if (envAppUrl.includes('pr-')) {
    return true;
  }

  return !isProductionDeployment(request);
}

/**
 * Check if a hostname is a preview deployment
 * Pure function that can be used on server or client.
 * If VITE_APP_URL env var is set, a preview host is any host that doesn't match it.
 * If no VITE_APP_URL, consider it non-preview.
 */
export function isPreviewHost(host: string): boolean {
  if (host.startsWith('localhost')) {
    return false;
  }

  const envAppUrl = getEnv().VITE_APP_URL;
  if (!envAppUrl) {
    return false;
  }

  try {
    const productionHost = new URL(envAppUrl).host;
    return host !== productionHost;
  } catch {
    return false;
  }
}

/**
 * Check if we're running in local development environment
 */
export function isLocalDevelopment(): boolean {
  return getEnv().NODE_ENV === 'development';
}

/**
 * Is this request being served on a local/network-dev host (localhost or a
 * bare IP)? Mirrors the local-access check in src/routes/__root.tsx: real
 * deployments — wherever they are hosted — are always reached by hostname,
 * never a bare IP or localhost.
 *
 * This is a host-based, env-independent signal. Unlike isProductionDeployment(),
 * it does not rely on VITE_APP_URL / NODE_ENV being present in the worker env
 * (they are only declared under wrangler.jsonc [env.test].vars, so they are
 * undefined in production and in the e2e-built worker alike).
 */
export function isLocalRequestHost(request: Request): boolean {
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  if (!host) return false;
  const hostname = (host.split(':')[0] ?? host).toLowerCase();
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    /^\d+\.\d+\.\d+\.\d+$/.test(hostname)
  );
}

/**
 * Server function to check if the current request is from a preview deployment.
 * Safe to call from client code (executes server-side via RPC).
 */
export const getIsPreviewFn = createServerFn({ method: 'GET' }).handler(
  async () => {
    const request = getRequest();
    return isPreviewDeployment(request);
  }
);
