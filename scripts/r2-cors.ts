/**
 * R2 bucket CORS — single source of truth.
 *
 * Why a module (not just JSON): rules depend on environment-derived origins
 * (localhost in dev, PR-preview wildcards in staging, the apex domain in prod),
 * so a static file would just push the templating elsewhere.
 *
 * Used by:
 *   - scripts/set-r2-cors.ts (standalone, re-runnable)
 *   - scripts/setup.ts       (interactive first-time setup)
 */

import { execFileSync } from 'child_process';
import { unlinkSync, writeFileSync } from 'fs';
import { resolve } from 'path';

// Field names match wrangler's expected JSON shape. `expose`/`maxAge` are
// silently dropped — must be `exposeHeaders`/`maxAgeSeconds`.
export type CorsRule = {
  allowed: { origins: string[]; methods: string[]; headers: string[] };
  exposeHeaders?: string[];
  maxAgeSeconds?: number;
};

export type BuildRulesOptions = {
  origins: string[];
  /**
   * Whether to allow browser PUT (presigned uploads). Read-only deployments
   * (PR previews, public asset buckets) can omit this.
   */
  includeWrites?: boolean;
};

/**
 * Build CORS rules suitable for an R2 bucket that's read from the browser via
 * `fetch()` — including mediabunny's `UrlSource`, which issues `Range` requests
 * and inspects `Content-Length` / `Accept-Ranges`. Native HTML elements
 * (`<video>`, `<img>`) don't need CORS, so this only matters for JS fetches.
 */
export function buildRules(opts: BuildRulesOptions): CorsRule[] {
  const methods = ['GET', 'HEAD'];
  if (opts.includeWrites) methods.push('PUT');

  return [
    {
      allowed: {
        origins: opts.origins,
        methods,
        // `Range` is required for mediabunny + any progressive reader.
        // `content-type` is required for presigned PUT uploads.
        headers: ['content-type', 'range'],
      },
      // mediabunny reads these to size the input and decide whether range
      // requests are supported.
      exposeHeaders: [
        'ETag',
        'Content-Length',
        'Content-Range',
        'Accept-Ranges',
      ],
      maxAgeSeconds: 3600,
    },
  ];
}

/**
 * Apply CORS rules to a bucket via `wrangler r2 bucket cors set`.
 * Wrangler authenticates via CLOUDFLARE_API_TOKEN or `wrangler login`.
 */
export function setBucketCors(bucketName: string, rules: CorsRule[]): void {
  const tmpFile = resolve(process.cwd(), `.cors-${bucketName}.tmp.json`);
  try {
    writeFileSync(tmpFile, JSON.stringify({ rules }, null, 2));
    execFileSync(
      'bunx',
      [
        'wrangler',
        'r2',
        'bucket',
        'cors',
        'set',
        bucketName,
        '--file',
        tmpFile,
        '--force',
      ],
      { stdio: 'inherit' }
    );
  } finally {
    try {
      unlinkSync(tmpFile);
    } catch {
      // ignore
    }
  }
}

/**
 * Wildcard origin patterns matching each hosting platform's PR preview URLs.
 * PR preview URLs are ephemeral and unique per PR, so we use platform-specific
 * wildcards to cover all of them with a single rule.
 */
export function derivePreviewOriginPatterns(opts: {
  platform: string | undefined;
  workersSubdomain?: string;
}): string[] {
  switch (opts.platform) {
    case 'cloudflare':
      return opts.workersSubdomain
        ? [`https://pr-*.${opts.workersSubdomain}.workers.dev`]
        : [];
    case 'vercel':
      return ['https://*.vercel.app'];
    case 'railway':
      return ['https://*.up.railway.app'];
    default:
      return [];
  }
}
