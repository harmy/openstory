/**
 * Team API Keys Schema
 * Encrypted storage for user-provided API keys (OpenRouter, Fal.ai)
 *
 * Keys are encrypted with AES-256-GCM. The encryption key lives in
 * environment variables, separate from the database.
 */

import {
  type InferInsertModel,
  type InferSelectModel,
  relations,
} from 'drizzle-orm';
import {
  integer,
  sqliteTable,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { teams } from './teams';
import { user } from './auth';

const API_KEY_PROVIDERS = ['openrouter', 'fal'] as const;
export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

const API_KEY_SOURCES = ['oauth', 'manual'] as const;
export type ApiKeySource = (typeof API_KEY_SOURCES)[number];

/**
 * Team API Keys table
 * Stores encrypted API keys per team per provider
 */
export const teamApiKeys = sqliteTable(
  'team_api_keys',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    provider: text().$type<ApiKeyProvider>().notNull(),

    // Encrypted key data (AES-256-GCM)
    encryptedKey: text('encrypted_key').notNull(),
    keyIv: text('key_iv').notNull(),
    keyTag: text('key_tag').notNull(),

    // Display hint (last 4 chars, safe to show in UI)
    keyHint: text('key_hint').notNull(),

    // How the key was provided
    source: text().$type<ApiKeySource>().default('manual').notNull(),

    // Status
    isActive: integer('is_active', { mode: 'boolean' }).default(true).notNull(),

    // Validity — set false + invalidReason when a workflow or re-validation
    // check finds the key rejected by the provider (e.g. 401/403). When
    // invalid, resolveKey() skips the team key and falls back to platform.
    isInvalid: integer('is_invalid', { mode: 'boolean' })
      .default(false)
      .notNull(),
    invalidReason: text('invalid_reason'),
    lastValidatedAt: integer('last_validated_at', { mode: 'timestamp' }),

    // Audit
    addedBy: text('added_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // One active key per team per provider
    uniqueIndex('idx_team_api_keys_team_provider').on(
      table.teamId,
      table.provider
    ),
    index('idx_team_api_keys_team_id').on(table.teamId),
  ]
);

// Relations
export const teamApiKeysRelations = relations(teamApiKeys, ({ one }) => ({
  team: one(teams, {
    fields: [teamApiKeys.teamId],
    references: [teams.id],
  }),
  addedByUser: one(user, {
    fields: [teamApiKeys.addedBy],
    references: [user.id],
  }),
}));

// Type exports
export type TeamApiKey = InferSelectModel<typeof teamApiKeys>;
export type NewTeamApiKey = InferInsertModel<typeof teamApiKeys>;
