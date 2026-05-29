/**
 * Vitest stub for the `cloudflare:workflows` virtual module (Workerd-only).
 * See `cloudflare-workers.stub.ts`. Aliased in `vitest.config.ts`.
 */

export class NonRetryableError extends Error {
  constructor(message?: string, name?: string) {
    super(message);
    this.name = name ?? 'NonRetryableError';
  }
}
