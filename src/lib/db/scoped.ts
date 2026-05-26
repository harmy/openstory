/**
 * Scoped Database Context
 * Factory that returns team-scoped query methods, auto-injecting teamId.
 * Sub-modules in ./scoped/ contain domain-specific methods.
 * Only this file and auth/config.ts should import getDb.
 */

import { getDb } from '#db-client';
import { sequences, teamMembers, teams, user } from '@/lib/db/schema';
import type { Sequence, User } from '@/lib/db/schema';
import type { TeamMemberRole } from '@/lib/db/schema/teams';
import { createAdminMethods } from '@/lib/db/scoped/admin';
import {
  createApiKeysMethods,
  createApiKeysReadMethods,
} from '@/lib/db/scoped/api-keys';
import {
  createBillingMethods,
  createBillingReadMethods,
} from '@/lib/db/scoped/billing';
import { createCharactersMethods } from '@/lib/db/scoped/characters';
import { createCharacterSheetVariantsMethods } from '@/lib/db/scoped/character-sheet-variants';
import { createFramePromptVariantsMethods } from '@/lib/db/scoped/frame-prompt-variants';
import { createFrameVariantsMethods } from '@/lib/db/scoped/frame-variants';
import { createLocationSheetVariantsMethods } from '@/lib/db/scoped/location-sheet-variants';
import { createSequenceExportsMethods } from '@/lib/db/scoped/sequence-exports';
import { createSequenceVariantsMethods } from '@/lib/db/scoped/sequence-variants';
import { createTalentSheetVariantsMethods } from '@/lib/db/scoped/talent-sheet-variants';
import { createFramesMethods } from '@/lib/db/scoped/frames';
import { createLibraryMethods } from '@/lib/db/scoped/library';
import {
  createLocationSheetsMethods,
  createLocationSheetsReadMethods,
  createLocationsMethods,
  createLocationsReadMethods,
} from '@/lib/db/scoped/location-library';
import { createSequenceElementsMethods } from '@/lib/db/scoped/sequence-elements';
import { createSequenceLocationsMethods } from '@/lib/db/scoped/sequence-locations';
import { createSequenceMusicPromptVariantsMethods } from '@/lib/db/scoped/sequence-music-prompt-variants';
import {
  createSequenceMethods,
  createSequenceReadMethods,
  createSequencesMethods,
  createSequencesReadMethods,
} from '@/lib/db/scoped/sequences';
import {
  createStylesMethods,
  createStylesReadMethods,
} from '@/lib/db/scoped/styles';
import {
  createTalentMethods,
  createTalentReadMethods,
} from '@/lib/db/scoped/talent';
import {
  createTeamManagementMethods,
  createTeamManagementReadMethods,
} from '@/lib/db/scoped/team-management';
import { and, eq, sql } from 'drizzle-orm';

export type {
  GiftTokenStatus,
  GiftTokenWithStatus,
  UserActivityRow,
} from '@/lib/db/scoped/admin';

export type {
  MergedVideoFieldsUpdate,
  MusicFieldsUpdate,
} from '@/lib/db/scoped/sequences';

/**
 * Resolve a user's default team (highest-role team).
 * Module-level function for bootstrap before scopedDb exists.
 */
export async function resolveUserTeam(
  userId: string
): Promise<{ teamId: string; role: TeamMemberRole; teamName: string } | null> {
  const db = getDb();
  const [result] = await db
    .select({
      teamId: teamMembers.teamId,
      role: teamMembers.role,
      teamName: teams.name,
      joinedAt: teamMembers.joinedAt,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(eq(teamMembers.userId, userId))
    .orderBy(
      sql`CASE
        WHEN ${teamMembers.role} = 'owner' THEN 1
        WHEN ${teamMembers.role} = 'admin' THEN 2
        WHEN ${teamMembers.role} = 'member' THEN 3
        WHEN ${teamMembers.role} = 'viewer' THEN 4
        ELSE 5
      END`
    )
    .limit(1);

  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
  return result ?? null;
}

/**
 * Check if a user is a member of a specific team and return their role.
 * Module-level function — does not require a scopedDb instance.
 */
export async function getUserTeamMembership(
  userId: string,
  teamId: string
): Promise<{ teamId: string; role: TeamMemberRole; teamName: string } | null> {
  const db = getDb();
  const [result] = await db
    .select({
      teamId: teamMembers.teamId,
      role: teamMembers.role,
      teamName: teams.name,
    })
    .from(teamMembers)
    .innerJoin(teams, eq(teamMembers.teamId, teams.id))
    .where(and(eq(teamMembers.userId, userId), eq(teamMembers.teamId, teamId)))
    .limit(1);

  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
  return result ?? null;
}

/**
 * Get a sequence by ID without team scoping.
 * Only for admin operations where team context isn't available yet.
 */
export async function getSequenceByIdUnscoped(
  sequenceId: string
): Promise<Sequence | null> {
  const db = getDb();
  const [result] = await db
    .select()
    .from(sequences)
    .where(eq(sequences.id, sequenceId));
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
  return result ?? null;
}

/**
 * Ensure user exists in database with team membership.
 * Creates user record, team, and membership if they don't exist.
 * Bootstrap function — does not require a scopedDb instance.
 */
export async function ensureUserAndTeam(authUser: {
  id: string;
  name?: string | null;
  email?: string | null;
}): Promise<{
  success: boolean;
  data?: User & { teamMembers?: Array<{ teamId: string; role: string }> };
  error?: string;
}> {
  try {
    const db = getDb();

    const foundUser = await db.query.user.findFirst({
      where: { id: authUser.id },
    });

    if (foundUser) {
      const memberships = await db
        .select({ teamId: teamMembers.teamId, role: teamMembers.role })
        .from(teamMembers)
        .where(eq(teamMembers.userId, authUser.id));

      if (memberships.length > 0) {
        return {
          success: true,
          data: { ...foundUser, teamMembers: memberships },
        };
      }
    }

    await db
      .insert(user)
      .values({
        id: authUser.id,
        name: authUser.name || 'Anonymous',
        email: authUser.email || `${authUser.id}@anonymous.local`,
      })
      .onConflictDoNothing();

    const teamName = authUser.name
      ? `${authUser.name}'s Team`
      : `Anonymous Team ${authUser.id.slice(0, 8)}`;
    const teamSlug = `team-${authUser.id.slice(0, 8)}`;

    const [team] = await db
      .insert(teams)
      .values({ name: teamName, slug: teamSlug })
      .returning();

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
    if (!team) throw new Error('Failed to create team');

    await db.insert(teamMembers).values({
      teamId: team.id,
      userId: authUser.id,
      role: 'owner',
    });

    const createdUser = await db.query.user.findFirst({
      where: { id: authUser.id },
    });

    if (!createdUser) throw new Error('Failed to retrieve created user');

    return {
      success: true,
      data: {
        ...createdUser,
        teamMembers: [{ teamId: team.id, role: 'owner' }],
      },
    };
  } catch (error) {
    console.error('[ensureUserAndTeam] Error:', error);
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unexpected error',
    };
  }
}

/**
 * Full scoped DB — requires userId for write operations that auto-inject audit fields.
 */
export function createScopedDb(teamId: string, userId: string) {
  const db = getDb();

  return {
    teamId,
    userId,

    sequences: createSequencesMethods(db, teamId, userId),
    sequence: (sequenceId: string) => createSequenceMethods(db, sequenceId),

    talent: createTalentMethods(db, teamId, userId),
    styles: createStylesMethods(db, teamId, userId),
    locations: createLocationsMethods(db, teamId, userId),
    locationSheets: createLocationSheetsMethods(db),
    library: createLibraryMethods(db, teamId),

    frames: createFramesMethods(db),
    frameVariants: createFrameVariantsMethods(db),
    framePromptVariants: createFramePromptVariantsMethods(db),
    characterSheetVariants: createCharacterSheetVariantsMethods(db),
    locationSheetVariants: createLocationSheetVariantsMethods(db),
    talentSheetVariants: createTalentSheetVariantsMethods(db),
    sequenceMusicPromptVariants: createSequenceMusicPromptVariantsMethods(db),
    sequenceVariants: createSequenceVariantsMethods(db),
    sequenceExports: createSequenceExportsMethods(db),

    characters: createCharactersMethods(db),
    sequenceLocations: createSequenceLocationsMethods(db),
    sequenceElements: createSequenceElementsMethods(db),

    billing: createBillingMethods(db, teamId, userId),
    apiKeys: createApiKeysMethods(db, teamId, userId),
    teamManagement: createTeamManagementMethods(db, teamId, userId),
  };
}

export type ScopedDb = ReturnType<typeof createScopedDb>;

/**
 * Read-only scoped DB — for webhooks, public queries, and system operations.
 * No userId required; write methods that need audit fields are not available.
 */
export function createReadOnlyScopedDb(teamId: string) {
  const db = getDb();

  return {
    teamId,

    sequences: createSequencesReadMethods(db, teamId),
    sequence: (sequenceId: string) => createSequenceReadMethods(db, sequenceId),

    talent: createTalentReadMethods(db, teamId),
    styles: createStylesReadMethods(db, teamId),
    locations: createLocationsReadMethods(db, teamId),
    locationSheets: createLocationSheetsReadMethods(db),
    library: createLibraryMethods(db, teamId),

    frames: createFramesMethods(db),
    frameVariants: createFrameVariantsMethods(db),
    framePromptVariants: createFramePromptVariantsMethods(db),
    characterSheetVariants: createCharacterSheetVariantsMethods(db),
    locationSheetVariants: createLocationSheetVariantsMethods(db),
    talentSheetVariants: createTalentSheetVariantsMethods(db),
    sequenceMusicPromptVariants: createSequenceMusicPromptVariantsMethods(db),
    sequenceVariants: createSequenceVariantsMethods(db),
    sequenceExports: createSequenceExportsMethods(db),

    characters: createCharactersMethods(db),
    sequenceLocations: createSequenceLocationsMethods(db),
    sequenceElements: createSequenceElementsMethods(db),

    billing: createBillingReadMethods(db, teamId),
    apiKeys: createApiKeysReadMethods(db, teamId),
    teamManagement: createTeamManagementReadMethods(db, teamId),
  };
}

export type ReadOnlyScopedDb = ReturnType<typeof createReadOnlyScopedDb>;

export function createSystemAdminScopedDb() {
  const db = getDb();

  return {
    admin: createAdminMethods(db),
  };
}

export type SystemAdminScopedDb = ReturnType<typeof createSystemAdminScopedDb>;
