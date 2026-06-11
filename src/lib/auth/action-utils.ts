/**
 * Authorization Utilities for Server Actions
 *
 * Provides centralized authentication and authorization functions for Next.js Server Actions.
 * These utilities handle user authentication, team membership verification, and role-based access control.
 *
 * @module lib/auth/action-utils
 */

import type { TeamRole } from '@/lib/auth/constants';
import { hasMinimumRole } from '@/lib/auth/constants';
import { getUserRole } from '@/lib/auth/permissions';

/**
 * Verify user has access to a team with at least the specified role
 *
 * Checks if the user is a member of the team and has the minimum required role.
 * Role hierarchy: viewer < member < admin < owner
 *
 * @param {string} userId - The user ID to check
 * @param {string} teamId - The team ID to check access for
 * @param {TeamRole} minRole - Minimum required role (default: "member")
 * @throws {Error} If user is not a team member or doesn't have sufficient role
 * @returns {Promise<TeamRole>} The user's actual role in the team
 *
 * @example
 * ```typescript
 * const role = await requireTeamMemberAccess(user.id, teamId, "member");
 * logger.info(`User has ${role} role`);
 * ```
 */
export async function requireTeamMemberAccess(
  userId: string,
  teamId: string,
  minRole: TeamRole = 'member'
): Promise<TeamRole> {
  const role = await getUserRole(userId, teamId);

  if (!role) {
    throw new Error('Access denied: not a member of this team');
  }

  // Check if user has minimum required role using shared constants
  if (!hasMinimumRole(role, minRole)) {
    throw new Error(`Access denied: ${minRole} role or higher required`);
  }

  return role;
}

/**
 * Verify user has admin or owner access to a team
 *
 * Convenience function for operations that require admin privileges.
 * Equivalent to `requireTeamMemberAccess(userId, teamId, "admin")`
 *
 * @param {string} userId - The user ID to check
 * @param {string} teamId - The team ID to check access for
 * @throws {Error} If user is not an admin or owner of the team
 * @returns {Promise<TeamRole>} The user's actual role (admin or owner)
 *
 * @example
 * ```typescript
 * const role = await requireTeamAdminAccess(user.id, teamId);
 * // User is guaranteed to be admin or owner
 * ```
 */
export async function requireTeamAdminAccess(
  userId: string,
  teamId: string
): Promise<TeamRole> {
  return requireTeamMemberAccess(userId, teamId, 'admin');
}

/**
 * Verify user is the owner of a team
 *
 * Convenience function for operations that require owner privileges.
 * Equivalent to `requireTeamMemberAccess(userId, teamId, "owner")`
 *
 * @param {string} userId - The user ID to check
 * @param {string} teamId - The team ID to check access for
 * @throws {Error} If user is not the owner of the team
 * @returns {Promise<TeamRole>} The user's role (always "owner")
 *
 * @example
 * ```typescript
 * await requireTeamOwnerAccess(user.id, teamId);
 * // User is guaranteed to be the team owner
 * ```
 */
export async function requireTeamOwnerAccess(
  userId: string,
  teamId: string
): Promise<TeamRole> {
  return requireTeamMemberAccess(userId, teamId, 'owner');
}
