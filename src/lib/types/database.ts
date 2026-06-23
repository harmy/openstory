/**
 * Database Types - Now using Drizzle ORM
 *
 * This file provides type exports for the database schema using Drizzle ORM.
 * All types use camelCase field names thanks to Drizzle's casing configuration.
 */

import type { Shot, Sequence, Style, User } from '@/lib/db/schema';

// JSON type for metadata fields (compatible with Supabase Json type)
export type Json = Record<string, unknown> | unknown[];

// Table row types (SELECT results - use camelCase field names)
export type { Shot, Sequence, Style };

// User profile alias (for backward compatibility)
export type UserProfile = User;
