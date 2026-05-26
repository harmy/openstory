/**
 * Apply CORS rules to OpenStory's R2 buckets. Idempotent — safe to re-run.
 *
 * Usage:
 *   bun scripts/set-r2-cors.ts                  # all envs
 *   bun scripts/set-r2-cors.ts --env=prd        # prod only
 *   bun scripts/set-r2-cors.ts --env=stg        # staging only
 *   bun scripts/set-r2-cors.ts --env=dev        # local dev only
 *
 * Auth: requires CLOUDFLARE_API_TOKEN in env, or `wrangler login`.
 */

import { buildRules, setBucketCors } from './r2-cors';

type EnvKey = 'prd' | 'dev';

type BucketConfig = {
  bucket: string;
  origins: string[];
  /** PUT allowed (presigned uploads from the browser). */
  includeWrites: boolean;
};

const CONFIG: Record<EnvKey, BucketConfig[]> = {
  prd: [
    {
      bucket: 'openstory-storage',
      origins: ['https://openstory.so', 'https://app.openstory.so'],
      includeWrites: true,
    },
    {
      bucket: 'openstory-public-assets',
      origins: ['https://openstory.so', 'https://app.openstory.so'],
      includeWrites: false,
    },
  ],
  dev: [
    {
      bucket: 'openstory-dev',
      origins: ['http://localhost:3000'],
      includeWrites: true,
    },
  ],
};

function parseFlag(name: string): string | undefined {
  const prefix = `--${name}=`;
  const arg = process.argv.find((a) => a.startsWith(prefix));
  return arg?.slice(prefix.length);
}

function main(): void {
  const envFlag = parseFlag('env') as EnvKey | undefined;
  const targets = envFlag ? CONFIG[envFlag] : Object.values(CONFIG).flat();

  if (!targets || targets.length === 0) {
    console.error(`Unknown --env=${envFlag}. Use prd, stg, or dev.`);
    process.exit(1);
  }

  for (const { bucket, origins, includeWrites } of targets) {
    console.log(
      `\n→ ${bucket} (origins: ${origins.join(', ')}, writes: ${includeWrites})`
    );
    setBucketCors(bucket, buildRules({ origins, includeWrites }));
  }
}

main();
