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

export function createApiKeysReadMethods(db: Database, teamId: string) {
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

  async function resolveKey(
    provider: ApiKeyProvider
  ): Promise<{ key: string; source: 'team' | 'platform' }> {
    const [row] = await db
      .select({
        encryptedKey: teamApiKeys.encryptedKey,
        keyIv: teamApiKeys.keyIv,
        keyTag: teamApiKeys.keyTag,
        isInvalid: teamApiKeys.isInvalid,
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

    // Skip team key if previously marked invalid — fall back to platform
    // so generations keep working while the user fixes the key.
    if (row && !row.isInvalid) {
      try {
        const decrypted = await decryptApiKey({
          encryptedKey: row.encryptedKey,
          keyIv: row.keyIv,
          keyTag: row.keyTag,
        });
        return { key: decrypted, source: 'team' };
      } catch (err) {
        // Decryption failed — encryption secret rotated or ciphertext corrupt.
        // Mark the row invalid inline so the banner surfaces and subsequent
        // calls skip straight to the platform key.
        const reason =
          err instanceof Error
            ? `Could not decrypt stored key: ${err.message}`
            : 'Could not decrypt stored key';
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
      }
    }

    const env = getEnv();
    const platformKey =
      provider === 'openrouter' ? env.OPENROUTER_KEY : env.FAL_KEY;

    if (!platformKey) {
      throw new Error(`No API key available for provider: ${provider}`);
    }

    return { key: platformKey, source: 'platform' };
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
    },
  };
}
