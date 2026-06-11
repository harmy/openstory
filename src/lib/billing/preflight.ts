/**
 * Pre-flight Billing Check
 * Shared utility for server functions to verify credit availability
 * before triggering workflows. Skips check if team has own BYOK keys.
 */

import type { Microdollars } from '@/lib/billing/money';
import type { ScopedDb } from '@/lib/db/scoped';
import { InsufficientCreditsError } from '@/lib/errors';

type Provider = 'fal' | 'openrouter';

/**
 * Verify a team can afford a generation before triggering it.
 * Skips the check entirely if the team has BYOK keys for all required providers.
 *
 * @param scopedDb - Scoped DB context for the team
 * @param estimatedCostMicros - Estimated raw cost in Microdollars
 * @param providers - Which BYOK providers bypass the check (default: ['fal'])
 * @param errorMessage - Custom error message for insufficient credits
 *
 * @throws InsufficientCreditsError if team lacks credits and has no BYOK keys
 */
export async function requireCredits(
  scopedDb: ScopedDb,
  estimatedCostMicros: Microdollars,
  opts: {
    providers?: Provider[];
    errorMessage?: string;
  } = {}
): Promise<void> {
  const providers = opts.providers ?? ['fal'];

  // Check if team has all required BYOK keys (any missing = need credits).
  // A fal key also satisfies the openrouter requirement: LLM calls route
  // through fal's OpenRouter endpoint on the team's fal key (issue #895).
  const keyChecks = await Promise.all(
    providers.map(
      async (provider) =>
        (await scopedDb.apiKeys.hasKey(provider)) ||
        (provider === 'openrouter' && (await scopedDb.apiKeys.hasKey('fal')))
    )
  );
  const hasAllKeys = keyChecks.every(Boolean);

  if (hasAllKeys) return;

  const canAfford =
    await scopedDb.billing.hasEnoughCredits(estimatedCostMicros);
  if (!canAfford) {
    throw new InsufficientCreditsError(
      opts.errorMessage ?? 'Insufficient credits'
    );
  }
}
