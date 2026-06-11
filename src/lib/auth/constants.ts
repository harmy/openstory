/**
 * Shared authentication and authorization constants
 *
 * This file contains all shared constants used across the auth system
 * to ensure consistency and avoid duplication.
 */

/**
 * Role hierarchy for team-based access control
 * Higher numbers = more permissions
 */
const ROLE_HIERARCHY = {
  viewer: 1,
  member: 2,
  admin: 3,
  owner: 4,
} as const;

/**
 * Team role type derived from ROLE_HIERARCHY keys
 */
export type TeamRole = keyof typeof ROLE_HIERARCHY;

/**
 * Check if a role has sufficient permissions
 */
export function hasMinimumRole(
  userRole: TeamRole,
  requiredRole: TeamRole
): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

/**
 * Invitation token configuration
 */
export const INVITATION_CONFIG = {
  TOKEN_BYTES: 32,
  TOKEN_ENCODING: 'base64url' as const, // URL-safe encoding
  EXPIRY_DAYS: 7,
} as const;
