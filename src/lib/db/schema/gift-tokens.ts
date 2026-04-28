import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  integer,
  sqliteTable,
  text,
  index,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { user } from './auth';
import { teams } from './teams';

export const giftTokens = sqliteTable(
  'gift_tokens',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    code: text().unique().notNull(),
    amountMicros: integer('amount_micros').notNull(),
    maxRedemptions: integer('max_redemptions').default(1).notNull(),
    createdByUserId: text('created_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }),
    note: text(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('idx_gift_tokens_code').on(table.code),
    index('idx_gift_tokens_created_by').on(table.createdByUserId),
  ]
);

export const giftTokenRedemptions = sqliteTable(
  'gift_token_redemptions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    giftTokenId: text('gift_token_id')
      .notNull()
      .references(() => giftTokens.id, { onDelete: 'cascade' }),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    redeemedAt: integer('redeemed_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('idx_gift_token_redemptions_token_team').on(
      table.giftTokenId,
      table.teamId
    ),
    index('idx_gift_token_redemptions_token').on(table.giftTokenId),
    index('idx_gift_token_redemptions_team').on(table.teamId),
  ]
);

export type GiftToken = InferSelectModel<typeof giftTokens>;
export type NewGiftToken = InferInsertModel<typeof giftTokens>;
export type GiftTokenRedemption = InferSelectModel<typeof giftTokenRedemptions>;
export type NewGiftTokenRedemption = InferInsertModel<
  typeof giftTokenRedemptions
>;
