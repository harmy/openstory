/**
 * requireCredits BYOK bypass — a fal key must satisfy the openrouter
 * requirement too, since LLM calls route through fal's OpenRouter endpoint
 * (issue #895). Regression: fal-only teams were blocked with "Insufficient
 * credits for script enhancement".
 */

import { micros } from '@/lib/billing/money';
import type { ScopedDb } from '@/lib/db/scoped';
import { InsufficientCreditsError } from '@/lib/errors';
import { describe, expect, it } from 'vitest';
import { requireCredits } from './preflight';

function fakeScopedDb(opts: {
  keys: Array<'fal' | 'openrouter'>;
  canAfford?: boolean;
}): ScopedDb {
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- minimal stub of the two methods requireCredits touches
  return {
    apiKeys: {
      hasKey: (provider: 'fal' | 'openrouter') =>
        Promise.resolve(opts.keys.includes(provider)),
    },
    billing: {
      hasEnoughCredits: () => Promise.resolve(opts.canAfford ?? false),
    },
  } as unknown as ScopedDb;
}

const COST = micros(1000);

describe('requireCredits BYOK coverage', () => {
  it('passes with only a fal key when openrouter is required (routes via fal)', async () => {
    const db = fakeScopedDb({ keys: ['fal'] });
    await expect(
      requireCredits(db, COST, { providers: ['fal', 'openrouter'] })
    ).resolves.toBeUndefined();
  });

  it('still requires credits when only an openrouter key exists but fal is required', async () => {
    const db = fakeScopedDb({ keys: ['openrouter'] });
    await expect(
      requireCredits(db, COST, { providers: ['fal', 'openrouter'] })
    ).rejects.toThrow(InsufficientCreditsError);
  });

  it('passes with both keys', async () => {
    const db = fakeScopedDb({ keys: ['fal', 'openrouter'] });
    await expect(
      requireCredits(db, COST, { providers: ['fal', 'openrouter'] })
    ).resolves.toBeUndefined();
  });

  it('falls through to the credit check (and passes) when affordable', async () => {
    const db = fakeScopedDb({ keys: [], canAfford: true });
    await expect(
      requireCredits(db, COST, { providers: ['fal', 'openrouter'] })
    ).resolves.toBeUndefined();
  });

  it('throws the custom message when no keys and no credits', async () => {
    const db = fakeScopedDb({ keys: [] });
    await expect(
      requireCredits(db, COST, {
        providers: ['fal', 'openrouter'],
        errorMessage: 'Insufficient credits to create sequences',
      })
    ).rejects.toThrow('Insufficient credits to create sequences');
  });
});
