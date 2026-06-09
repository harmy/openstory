/**
 * Scoped API Keys Sub-module
 * Team-scoped API key management for external providers (OpenRouter, Fal.ai).
 * Handles CRUD operations and key resolution (team key -> platform fallback).
 */

import { and, eq } from 'drizzle-orm';
import type { Database } from '@/lib/db/client';
import { getEnv } from '#env';
import {
  decryptApiKey,
  encryptApiKey,
  getKeyHint,
} from '@/lib/crypto/api-key-encryption';
import { type ApiKeyProvider, teamApiKeys } from '@/lib/db/schema';

import { getLogger, serializeError } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'db', 'api-keys']);

type ApiKeyInfo = {
  id: string;
  provider: ApiKeyProvider;
  keyHint: string;
  source: 'oauth' | 'manual';
  isActive: boolean;
  isInvalid: boolean;
  invalidReason: string | null;
  lastValidatedAt: Date | null;
  addedBy: string;
  createdAt: Date;
};

// `fallbackReason` is set when a team key existed but was skipped (invalid
// or undecryptable); callers use it to surface the BYOK fallback.
export type ResolvedApiKey =
  | { key: string; source: 'team' }
  | { key: string; source: 'platform'; fallbackReason?: string };

// The cached shape of a `team_api_keys` lookup. Holds the *encrypted* row
// (ciphertext + invalid flag) only — never the decrypted key. `resolveKey`
// memoizes this per scope to avoid redundant D1 reads, then decrypts fresh on
// each call so plaintext is never retained in the cache (issue #864).
type CachedKeyLookup =
  | { found: false }
  | {
      found: true;
      encryptedKey: string;
      keyIv: string;
      keyTag: string;
      isInvalid: boolean;
      invalidReason: string | null;
    };

export function createApiKeysReadMethods(db: Database, teamId: string) {
  // Per-scope memoization of the `team_api_keys` row lookup. A ScopedDb is
  // built fresh per workflow run / request, so this cache lives exactly one
  // run — there is no cross-run staleness (issue #864). Without it, `resolveKey`
  // runs a fresh D1 SELECT for every LLM/fal sub-call; under burst (the #801
  // 90-sequence render) the redundant identical reads exhausted D1 and
  // hard-failed sequences in phase 3.
  //
  // We cache only the *encrypted* row (ciphertext + invalid flag), never the
  // decrypted key — `resolveKey` decrypts fresh on each call, so the plaintext
  // key lives only for the duration of one call rather than the whole run. The
  // cache is in-isolate heap, scoped to one team, and never persisted.
  const keyLookupCache = new Map<ApiKeyProvider, Promise<CachedKeyLookup>>();

  // Drop a cached lookup so the next resolveKey re-reads from D1. Called by the
  // write methods after a save/delete/mark so a rotation or invalidation
  // within the same scope can't keep serving the stale row.
  function invalidateResolveKeyCache(provider?: ApiKeyProvider): void {
    if (provider) keyLookupCache.delete(provider);
    else keyLookupCache.clear();
  }

  async function listKeys(): Promise<ApiKeyInfo[]> {
    const rows = await db
      .select({
        id: teamApiKeys.id,
        provider: teamApiKeys.provider,
        keyHint: teamApiKeys.keyHint,
        source: teamApiKeys.source,
        isActive: teamApiKeys.isActive,
        isInvalid: teamApiKeys.isInvalid,
        invalidReason: teamApiKeys.invalidReason,
        lastValidatedAt: teamApiKeys.lastValidatedAt,
        addedBy: teamApiKeys.addedBy,
        createdAt: teamApiKeys.createdAt,
      })
      .from(teamApiKeys)
      .where(eq(teamApiKeys.teamId, teamId));

    return rows;
  }

  async function hasKey(provider: ApiKeyProvider): Promise<boolean> {
    const [row] = await db
      .select({ id: teamApiKeys.id })
      .from(teamApiKeys)
      .where(
        and(
          eq(teamApiKeys.teamId, teamId),
          eq(teamApiKeys.provider, provider),
          eq(teamApiKeys.isActive, true)
        )
      )
      .limit(1);

    return !!row;
  }

  async function hasInvalidKey(provider: ApiKeyProvider): Promise<boolean> {
    const [row] = await db
      .select({ id: teamApiKeys.id })
      .from(teamApiKeys)
      .where(
        and(
          eq(teamApiKeys.teamId, teamId),
          eq(teamApiKeys.provider, provider),
          eq(teamApiKeys.isActive, true),
          eq(teamApiKeys.isInvalid, true)
        )
      )
      .limit(1);

    return !!row;
  }

  // Read the encrypted `team_api_keys` row for `provider`, memoized per scope:
  // D1 is hit at most once per provider per run, and concurrent in-flight reads
  // collapse onto the same promise. A rejected read is evicted so a later caller
  // (or a step retry in a surviving isolate) can re-read rather than inheriting
  // a cached failure.
  function readKeyRow(provider: ApiKeyProvider): Promise<CachedKeyLookup> {
    const cached = keyLookupCache.get(provider);
    if (cached) return cached;

    const pending = readKeyRowUncached(provider);
    keyLookupCache.set(provider, pending);
    void pending.catch(() => {
      if (keyLookupCache.get(provider) === pending) {
        keyLookupCache.delete(provider);
      }
    });
    return pending;
  }

  async function readKeyRowUncached(
    provider: ApiKeyProvider
  ): Promise<CachedKeyLookup> {
    const [row] = await db
      .select({
        encryptedKey: teamApiKeys.encryptedKey,
        keyIv: teamApiKeys.keyIv,
        keyTag: teamApiKeys.keyTag,
        isInvalid: teamApiKeys.isInvalid,
        invalidReason: teamApiKeys.invalidReason,
      })
      .from(teamApiKeys)
      .where(
        and(
          eq(teamApiKeys.teamId, teamId),
          eq(teamApiKeys.provider, provider),
          eq(teamApiKeys.isActive, true)
        )
      )
      .limit(1);

    if (!row) return { found: false };
    return { found: true, ...row };
  }

  // Resolve the usable key for `provider`. The D1 lookup is memoized per scope;
  // the decrypted key is produced fresh on every call (and is GC-eligible as
  // soon as the caller is done), so plaintext is never retained in the cache.
  async function resolveKey(provider: ApiKeyProvider): Promise<ResolvedApiKey> {
    const platformFallback = (fallbackReason?: string): ResolvedApiKey => {
      const env = getEnv();
      const platformKey =
        provider === 'openrouter' ? env.OPENROUTER_KEY : env.FAL_KEY;
      if (!platformKey) {
        throw new Error(`No API key available for provider: ${provider}`);
      }
      return { key: platformKey, source: 'platform', fallbackReason };
    };

    let lookup: CachedKeyLookup;
    try {
      lookup = await readKeyRow(provider);
    } catch (err) {
      // The D1 read failed. Log the FULL cause chain here, in-isolate, while
      // the underlying driver error is still on `DrizzleQueryError.cause` —
      // that link is stripped once the error crosses a Cloudflare Workflows
      // step boundary, so this is the only place the real D1 reason (overload
      // vs connection-reset vs rate-limit) is observable. This read sits on
      // every generation path and is the first to fail under burst (#864).
      logger.error('team_api_keys read failed', {
        provider,
        teamId,
        err: serializeError(err),
      });
      throw err;
    }

    if (!lookup.found) return platformFallback();

    if (lookup.isInvalid) {
      const reason = lookup.invalidReason ?? 'Team API key marked invalid';
      logger.warn('Falling back to platform key', {
        provider,
        teamId,
        reason,
      });
      return platformFallback(reason);
    }

    try {
      const decrypted = await decryptApiKey({
        encryptedKey: lookup.encryptedKey,
        keyIv: lookup.keyIv,
        keyTag: lookup.keyTag,
      });
      return { key: decrypted, source: 'team' };
    } catch (err) {
      // Mark the row invalid inline so the invalid-key banner surfaces and
      // subsequent calls skip straight to the platform key without retrying
      // decryption (covers secret rotation and corrupt ciphertext).
      const reason =
        err instanceof Error
          ? `Could not decrypt stored key: ${err.message}`
          : 'Could not decrypt stored key';
      logger.error('Decryption failed, marking key invalid', {
        provider,
        teamId,
        error: err,
      });
      await db
        .update(teamApiKeys)
        .set({
          isInvalid: true,
          invalidReason: reason,
          lastValidatedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(teamApiKeys.teamId, teamId),
            eq(teamApiKeys.provider, provider)
          )
        );
      // Flip the cached lookup to invalid so other calls in this scope skip the
      // doomed decrypt and don't re-issue the mark-invalid UPDATE.
      keyLookupCache.set(
        provider,
        Promise.resolve({ ...lookup, isInvalid: true, invalidReason: reason })
      );
      return platformFallback(reason);
    }
  }

  async function validateKey(
    provider: ApiKeyProvider,
    apiKey: string
  ): Promise<{ valid: boolean; error?: string }> {
    if (provider === 'openrouter') {
      const response = await fetch('https://openrouter.ai/api/v1/auth/key', {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      if (response.ok) return { valid: true };
      return { valid: false, error: `OpenRouter returned ${response.status}` };
    }

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: literal comparison in if/else chain
    if (provider === 'fal') {
      const response = await fetch(
        'https://queue.fal.run/fal-ai/flux/schnell',
        {
          method: 'POST',
          headers: {
            Authorization: `Key ${apiKey}`,
            'Content-Type': 'application/json',
          },
          body: '{}',
        }
      );
      if (response.status === 401) {
        return { valid: false, error: 'Invalid Fal.ai API key' };
      }
      return { valid: true };
    }

    throw new Error(`Unknown provider`);
  }

  return {
    listKeys,
    hasKey,
    hasInvalidKey,
    resolveKey,
    validateKey,
    invalidateResolveKeyCache,
  };
}

export function createApiKeysMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  const readMethods = createApiKeysReadMethods(db, teamId);

  const markKeyInvalid = async (
    provider: ApiKeyProvider,
    reason: string
  ): Promise<void> => {
    await db
      .update(teamApiKeys)
      .set({
        isInvalid: true,
        invalidReason: reason,
        lastValidatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(teamApiKeys.teamId, teamId), eq(teamApiKeys.provider, provider))
      );
    readMethods.invalidateResolveKeyCache(provider);
  };

  const markKeyValid = async (provider: ApiKeyProvider): Promise<void> => {
    await db
      .update(teamApiKeys)
      .set({
        isInvalid: false,
        invalidReason: null,
        lastValidatedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(teamApiKeys.teamId, teamId), eq(teamApiKeys.provider, provider))
      );
    readMethods.invalidateResolveKeyCache(provider);
  };

  const revalidateStoredKey = async (
    provider: ApiKeyProvider
  ): Promise<{ valid: boolean; error?: string; hasKey: boolean }> => {
    const [row] = await db
      .select({
        encryptedKey: teamApiKeys.encryptedKey,
        keyIv: teamApiKeys.keyIv,
        keyTag: teamApiKeys.keyTag,
      })
      .from(teamApiKeys)
      .where(
        and(
          eq(teamApiKeys.teamId, teamId),
          eq(teamApiKeys.provider, provider),
          eq(teamApiKeys.isActive, true)
        )
      )
      .limit(1);

    if (!row) return { valid: false, hasKey: false };

    let decrypted: string;
    try {
      decrypted = await decryptApiKey({
        encryptedKey: row.encryptedKey,
        keyIv: row.keyIv,
        keyTag: row.keyTag,
      });
    } catch (err) {
      const reason =
        err instanceof Error
          ? `Could not decrypt stored key: ${err.message}`
          : 'Could not decrypt stored key';
      await markKeyInvalid(provider, reason);
      return { valid: false, error: reason, hasKey: true };
    }

    const result = await readMethods.validateKey(provider, decrypted);

    if (result.valid) {
      await markKeyValid(provider);
    } else {
      await markKeyInvalid(provider, result.error ?? 'Validation failed');
    }

    return { ...result, hasKey: true };
  };

  return {
    ...readMethods,

    markKeyInvalid,
    markKeyValid,
    revalidateStoredKey,

    saveKey: async (params: {
      provider: ApiKeyProvider;
      apiKey: string;
      source?: 'oauth' | 'manual';
    }): Promise<ApiKeyInfo> => {
      const encrypted = await encryptApiKey(params.apiKey);
      const hint = getKeyHint(params.apiKey);
      const now = new Date();

      await db
        .delete(teamApiKeys)
        .where(
          and(
            eq(teamApiKeys.teamId, teamId),
            eq(teamApiKeys.provider, params.provider)
          )
        );

      const [row] = await db
        .insert(teamApiKeys)
        .values({
          teamId,
          provider: params.provider,
          encryptedKey: encrypted.encryptedKey,
          keyIv: encrypted.keyIv,
          keyTag: encrypted.keyTag,
          keyHint: hint,
          source: params.source ?? 'manual',
          isActive: true,
          isInvalid: false,
          invalidReason: null,
          lastValidatedAt: now,
          addedBy: userId,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      if (!row) {
        throw new Error(
          `saveKey: insert returned no row for team ${teamId}, provider ${params.provider}`
        );
      }

      readMethods.invalidateResolveKeyCache(params.provider);

      return {
        id: row.id,
        provider: row.provider,
        keyHint: row.keyHint,
        source: row.source,
        isActive: row.isActive,
        isInvalid: row.isInvalid,
        invalidReason: row.invalidReason,
        lastValidatedAt: row.lastValidatedAt,
        addedBy: row.addedBy,
        createdAt: row.createdAt,
      };
    },

    deleteKey: async (provider: ApiKeyProvider): Promise<void> => {
      await db
        .delete(teamApiKeys)
        .where(
          and(
            eq(teamApiKeys.teamId, teamId),
            eq(teamApiKeys.provider, provider)
          )
        );
      readMethods.invalidateResolveKeyCache(provider);
    },
  };
}
