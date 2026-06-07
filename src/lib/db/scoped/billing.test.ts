/**
 * In-memory DB tests for `deductCredits` idempotency (issue #846 RC1).
 *
 * A workflow `step.do` that throws partway (or is killed by an engine abort)
 * re-runs its closure from the top, so `deductCredits` must be safe to replay:
 * with an `idempotencyKey`, the balance UPDATE and the transaction INSERT run
 * in one atomic `db.batch` guarded by the partial unique index on
 * `(team_id, idempotency_key)` — a replay is a no-op that recovers the
 * original transaction id instead of double-debiting the team.
 */

import { applyMarkup } from '@/lib/billing/constants';
import { micros, negateMicros } from '@/lib/billing/money';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import { credits, teams, transactions, user } from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createBillingMethods } from './billing';

let client: Client;
let db: Database;
let teamId = '';
let userId = '';

const STARTING_BALANCE = 100_000_000; // $100

async function seed() {
  await db.delete(transactions);
  await db.delete(credits);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
  userId = generateId();
  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  await db
    .insert(user)
    .values({ id: userId, name: 'U', email: `${userId}@example.com` });
  await db.insert(credits).values({ teamId, balance: STARTING_BALANCE });
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

describe('deductCredits with an idempotencyKey', () => {
  const rawCost = micros(1_000_000); // $1 raw

  it('debits once and writes a single ledger row', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const charged = applyMarkup(rawCost);

    const result = await billing.deductCredits(rawCost, {
      idempotencyKey: 'wf-instance-1:image',
    });

    expect(result.chargedAmount).toBe(charged);
    expect(result.newBalance).toBe(STARTING_BALANCE - charged);
    expect(result.transactionId).not.toBe('');

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.teamId, teamId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount).toBe(negateMicros(charged));
    // The balanceAfter subquery must see the post-UPDATE balance (the batch
    // statements run sequentially inside one transaction).
    expect(rows[0]?.balanceAfter).toBe(STARTING_BALANCE - charged);
    expect(rows[0]?.idempotencyKey).toBe('wf-instance-1:image');
  });

  it('replay with the same key is a no-op that returns the original transaction id', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const charged = applyMarkup(rawCost);

    const first = await billing.deductCredits(rawCost, {
      idempotencyKey: 'wf-instance-1:image',
    });
    const replay = await billing.deductCredits(rawCost, {
      idempotencyKey: 'wf-instance-1:image',
    });

    // Must not throw, must not double-debit, must recover the original id.
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.newBalance).toBe(STARTING_BALANCE - charged);

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.teamId, teamId));
    expect(rows).toHaveLength(1);

    const [credit] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId));
    expect(credit?.balance).toBe(STARTING_BALANCE - charged);
  });

  it('distinct keys are distinct charges', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const charged = applyMarkup(rawCost);

    await billing.deductCredits(rawCost, {
      idempotencyKey: 'wf-instance-1:image',
    });
    await billing.deductCredits(rawCost, {
      idempotencyKey: 'wf-instance-1:motion',
    });

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.teamId, teamId));
    expect(rows).toHaveLength(2);

    // Each ledger row must persist the balance as of ITS charge — a stale
    // read in the balanceAfter subquery would surface on the second row.
    const imageRow = rows.find(
      (r) => r.idempotencyKey === 'wf-instance-1:image'
    );
    const motionRow = rows.find(
      (r) => r.idempotencyKey === 'wf-instance-1:motion'
    );
    expect(imageRow?.balanceAfter).toBe(STARTING_BALANCE - charged);
    expect(motionRow?.balanceAfter).toBe(STARTING_BALANCE - 2 * charged);

    const [credit] = await db
      .select({ balance: credits.balance })
      .from(credits)
      .where(eq(credits.teamId, teamId));
    expect(credit?.balance).toBe(STARTING_BALANCE - 2 * charged);
  });

  it('the same key under a different team charges both teams (key is team-scoped)', async () => {
    const otherTeamId = generateId();
    await db.insert(teams).values({ id: otherTeamId, name: 'T2', slug: 't2' });
    await db
      .insert(credits)
      .values({ teamId: otherTeamId, balance: STARTING_BALANCE });

    const billingA = createBillingMethods(db, teamId, userId);
    const billingB = createBillingMethods(db, otherTeamId, userId);

    const a = await billingA.deductCredits(rawCost, {
      idempotencyKey: 'shared-key',
    });
    const b = await billingB.deductCredits(rawCost, {
      idempotencyKey: 'shared-key',
    });

    expect(a.transactionId).not.toBe(b.transactionId);
    const charged = applyMarkup(rawCost);
    expect(a.newBalance).toBe(STARTING_BALANCE - charged);
    expect(b.newBalance).toBe(STARTING_BALANCE - charged);
  });
});

describe('deductCredits without an idempotencyKey (keyless path)', () => {
  const rawCost = micros(1_000_000);

  it('charges on every call (HTTP single-shot semantics preserved)', async () => {
    const billing = createBillingMethods(db, teamId, userId);
    const charged = applyMarkup(rawCost);

    const r1 = await billing.deductCredits(rawCost, {
      description: 'one',
    });
    const r2 = await billing.deductCredits(rawCost, {
      description: 'two',
    });

    expect(r1.transactionId).not.toBe(r2.transactionId);
    expect(r2.newBalance).toBe(STARTING_BALANCE - 2 * charged);

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.teamId, teamId));
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.idempotencyKey === null)).toBe(true);
  });

  it('returns early without writing anything for a non-positive cost', async () => {
    const billing = createBillingMethods(db, teamId, userId);

    const result = await billing.deductCredits(micros(0));

    expect(result.newBalance).toBe(STARTING_BALANCE);
    expect(result.transactionId).toBe('');

    const rows = await db
      .select()
      .from(transactions)
      .where(eq(transactions.teamId, teamId));
    expect(rows).toHaveLength(0);
  });
});
