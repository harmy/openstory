/**
 * Scoped Admin Sub-module
 * Admin-only operations: gift token creation, listing, and redemption.
 * Not team-scoped (admin operations span all teams).
 */

import { micros, microsToUsd, usdToMicros } from '@/lib/billing/money';
import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import { frames, sequences, teamMembers, teams, user } from '@/lib/db/schema';
import type { Frame, Sequence } from '@/lib/db/schema';
import { giftTokenRedemptions, giftTokens } from '@/lib/db/schema/gift-tokens';
import type { GiftToken } from '@/lib/db/schema/gift-tokens';
import { ValidationError } from '@/lib/errors';
import { and, asc, count, desc, eq, like, not, or, sql } from 'drizzle-orm';

// Ambiguity-free alphabet (no 0/O/1/I) -- 32 chars -> 32^6 ~ 1B combinations
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

function generateGiftCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes)
    .map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length])
    .join('');
}

export type GiftTokenStatus = 'available' | 'fully_redeemed' | 'expired';

export function getGiftTokenStatus(
  token: GiftToken,
  redemptionCount: number
): GiftTokenStatus {
  if (redemptionCount >= token.maxRedemptions) return 'fully_redeemed';
  if (token.expiresAt && token.expiresAt < new Date()) return 'expired';
  return 'available';
}

export type GiftTokenWithStatus = GiftToken & {
  status: GiftTokenStatus;
  amountUsd: number;
  redemptionCount: number;
};

export function createAdminMethods(db: Database) {
  async function createGiftToken(opts: {
    createdByUserId: string;
    amountUsd: number;
    maxRedemptions?: number;
    note?: string;
    expiresAt?: Date;
  }): Promise<GiftToken> {
    if (opts.amountUsd <= 0) {
      throw new ValidationError('Gift token amount must be positive');
    }

    const maxRedemptions = opts.maxRedemptions ?? 1;
    if (maxRedemptions < 1) {
      throw new ValidationError('Max redemptions must be at least 1');
    }

    const code = generateGiftCode();
    const amountMicros = usdToMicros(opts.amountUsd);

    const [token] = await db
      .insert(giftTokens)
      .values({
        id: generateId(),
        code,
        amountMicros,
        maxRedemptions,
        createdByUserId: opts.createdByUserId,
        note: opts.note ?? null,
        expiresAt: opts.expiresAt ?? null,
      })
      .returning();

    return token;
  }

  async function listGiftTokens(): Promise<GiftTokenWithStatus[]> {
    const redemptionCountSq = db
      .select({
        giftTokenId: giftTokenRedemptions.giftTokenId,
        count: count().as('count'),
      })
      .from(giftTokenRedemptions)
      .groupBy(giftTokenRedemptions.giftTokenId)
      .as('redemption_counts');

    const tokens = await db
      .select({
        token: giftTokens,
        redemptionCount: sql<number>`coalesce(${redemptionCountSq.count}, 0)`,
      })
      .from(giftTokens)
      .leftJoin(
        redemptionCountSq,
        eq(giftTokens.id, redemptionCountSq.giftTokenId)
      )
      .orderBy(desc(giftTokens.createdAt));

    return tokens.map(({ token, redemptionCount }) => ({
      ...token,
      redemptionCount,
      status: getGiftTokenStatus(token, redemptionCount),
      amountUsd: microsToUsd(micros(token.amountMicros)),
    }));
  }

  // ---- Support: user search + cross-team sequence/frame access ----

  type UserSearchResult = {
    userId: string;
    name: string;
    email: string;
    image: string | null;
    teamId: string;
    teamName: string;
    role: string;
  };

  async function searchUsers(query: string): Promise<UserSearchResult[]> {
    const pattern = `%${query}%`;
    const results = await db
      .select({
        userId: user.id,
        name: user.name,
        email: user.email,
        image: user.image,
        teamId: teams.id,
        teamName: teams.name,
        role: teamMembers.role,
      })
      .from(user)
      .innerJoin(teamMembers, eq(user.id, teamMembers.userId))
      .innerJoin(teams, eq(teamMembers.teamId, teams.id))
      .where(or(like(user.email, pattern), like(user.name, pattern)))
      .orderBy(asc(user.name))
      .limit(20);

    return results;
  }

  async function getSequencesForTeam(teamId: string): Promise<Sequence[]> {
    return await db
      .select()
      .from(sequences)
      .where(
        and(eq(sequences.teamId, teamId), not(eq(sequences.status, 'archived')))
      )
      .orderBy(desc(sequences.updatedAt));
  }

  async function getFramesForSequence(sequenceId: string): Promise<Frame[]> {
    return await db
      .select()
      .from(frames)
      .where(eq(frames.sequenceId, sequenceId))
      .orderBy(asc(frames.orderIndex));
  }

  return {
    createGiftToken,
    listGiftTokens,
    searchUsers,
    getSequencesForTeam,
    getFramesForSequence,
  };
}
