import { type InferInsertModel, type InferSelectModel, sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { user } from './auth';
import { teams } from './teams';

// Enum values as constants (SQLite doesn't have native enums)
const TRANSACTION_TYPES = [
  'credit_purchase',
  'credit_usage',
  'credit_refund',
  'credit_adjustment',
] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const credits = sqliteTable(
  'credits',
  {
    teamId: text('team_id')
      .primaryKey()
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    balance: integer().default(0).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [check('positive_balance', sql`${table.balance} >= 0`)]
);

export const transactions = sqliteTable(
  'transactions',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    userId: text('user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    type: text().$type<TransactionType>().notNull(),
    amount: integer().notNull(),
    balanceAfter: integer('balance_after').notNull(),
    metadata: text({ mode: 'json' }).$defaultFn(() => ({})),
    stripeSessionId: text('stripe_session_id'),
    description: text(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_transactions_created_at').on(table.createdAt),
    index('idx_transactions_type').on(table.type),
    index('idx_transactions_team_id').on(table.teamId),
    index('idx_transactions_user_id').on(table.userId),
    uniqueIndex('idx_transactions_stripe_session_id').on(table.stripeSessionId),
  ]
);

export const teamBillingSettings = sqliteTable('team_billing_settings', {
  teamId: text('team_id')
    .primaryKey()
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),
  stripeCustomerId: text('stripe_customer_id'),
  autoTopUpEnabled: integer('auto_top_up_enabled', { mode: 'boolean' })
    .default(false)
    .notNull(),
  autoTopUpThresholdMicros: integer('auto_top_up_threshold_micros').default(
    5_000_000
  ),
  autoTopUpAmountMicros: integer('auto_top_up_amount_micros').default(
    100_000_000
  ),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .$defaultFn(() => new Date())
    .notNull(),
});

// Credit Batches — tracks each top-up for future expiration
const CREDIT_BATCH_SOURCES = [
  'stripe_checkout',
  'auto_topup',
  'gift_code',
  'adjustment',
  'migration',
] as const;
export type CreditBatchSource = (typeof CREDIT_BATCH_SOURCES)[number];

export const creditBatches = sqliteTable(
  'credit_batches',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    teamId: text('team_id')
      .notNull()
      .references(() => teams.id, { onDelete: 'cascade' }),
    originalAmount: integer('original_amount').notNull(),
    remainingAmount: integer('remaining_amount').notNull(),
    source: text().$type<CreditBatchSource>().notNull(),
    transactionId: text('transaction_id').references(() => transactions.id, {
      onDelete: 'set null',
    }),
    expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_credit_batches_team_id').on(table.teamId),
    index('idx_credit_batches_team_remaining_created').on(
      table.teamId,
      table.remainingAmount,
      table.createdAt
    ),
    index('idx_credit_batches_expires_at').on(table.expiresAt),
  ]
);

// Type exports
export type Credit = InferSelectModel<typeof credits>;
export type NewCredit = InferInsertModel<typeof credits>;

export type Transaction = InferSelectModel<typeof transactions>;
export type NewTransaction = InferInsertModel<typeof transactions>;

export type TeamBillingSetting = InferSelectModel<typeof teamBillingSettings>;
export type NewTeamBillingSetting = InferInsertModel<
  typeof teamBillingSettings
>;

export type CreditBatch = InferSelectModel<typeof creditBatches>;
export type NewCreditBatch = InferInsertModel<typeof creditBatches>;
