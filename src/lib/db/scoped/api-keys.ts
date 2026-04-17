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
        addedBy: teamApiKeys.addedBy,
        createdAt: teamApiKeys.createdAt,
      })
      .from(teamApiKeys)
      .where(eq(teamApiKeys.teamId, teamId));

    return rows as ApiKeyInfo[];
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

  async function resolveKey(
    provider: ApiKeyProvider
  ): Promise<{ key: string; source: 'team' | 'platform' }> {
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

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
    if (row) {
      const decrypted = await decryptApiKey({
        encryptedKey: row.encryptedKey,
        keyIv: row.keyIv,
        keyTag: row.keyTag,
      });
      return { key: decrypted, source: 'team' };
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
    resolveKey,
    validateKey,
  };
}

export function createApiKeysMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  return {
    ...createApiKeysReadMethods(db, teamId),

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
