/**
 * Drizzle ORM Schema Index
 * Central export point for all database schemas.
 *
 * Relations are defined separately in ./relations.ts using defineRelations()
 * (Drizzle Relations v2 — single consolidated definition, no per-table relations() calls).
 */

import { account, apikey, passkey, session, user, verification } from './auth';

import { teamInvitations, teamMembers, teams } from './teams';

import { sequences } from './sequences';

import { shots } from './shots';

import { shotVariants } from './shot-variants';

import { characterSheetVariants } from './character-sheet-variants';

import { locationSheetVariants } from './location-sheet-variants';

import { talentSheetVariants } from './talent-sheet-variants';

import { shotPromptVariants } from './shot-prompt-variants';

import { sequenceMusicPromptVariants } from './sequence-music-prompt-variants';

import { sequenceMusicVariants } from './sequence-music-variants';
import { sequenceExports } from './sequence-exports';

import { characters } from './characters';

// Location Library (team-level templates)
import { locationLibrary } from './location-library';

// Sequence Locations (script-extracted)
import { sequenceLocations } from './sequence-locations';

import { locationSheets } from './location-sheets';

// Sequence Elements (user-uploaded reference images)
import { sequenceElements } from './sequence-elements';

import { talent, talentMedia, talentSheets } from './talent';

import {
  audio,
  StyleConfigSchema,
  StyleSampleVideoSchema,
  styles,
  vfx,
} from './libraries';

import {
  creditBatches,
  credits,
  teamBillingSettings,
  transactions,
} from './credits';

import { teamApiKeys } from './team-api-keys';

import { giftTokenRedemptions, giftTokens } from './gift-tokens';

import { appMetadata } from './app-metadata';

// Better Auth tables
export { account, apikey, passkey, session, user, verification };

export type { User } from './auth';

// Teams
export { teamInvitations, teamMembers, teams };

// Sequences
export { sequences };

export type { NewSequence, Sequence } from './sequences';

// Shots
export { shots };

export type { NewShot, Shot } from './shots';

// Shot Variants
export { shotVariants };

export type { ShotVariant, NewShotVariant } from './shot-variants';

// Sheet Variants (Stage 2: divergent character/location/talent sheet outputs)
export { characterSheetVariants };

export type {
  CharacterSheetVariant,
  NewCharacterSheetVariant,
} from './character-sheet-variants';

export { locationSheetVariants };

export type {
  LocationSheetVariant,
  LocationSheetVariantParentType,
  NewLocationSheetVariant,
} from './location-sheet-variants';

export { talentSheetVariants };

export type {
  NewTalentSheetVariant,
  TalentSheetVariant,
} from './talent-sheet-variants';

// Shot Prompt Variants (visual/motion prompt history)
export { shotPromptVariants };

export { FRAME_PROMPT_TYPES } from './shot-prompt-variants';

export type {
  FramePromptType,
  ShotPromptVariant,
  ShotPromptVariantComponents,
  PromptVariantSource,
} from './shot-prompt-variants';

// Sequence Music Prompt Variants (music prompt history)
export { sequenceMusicPromptVariants };

export type { SequenceMusicPromptVariant } from './sequence-music-prompt-variants';

// Sequence-level variants (music)
export { sequenceMusicVariants };

export type {
  NewSequenceMusicVariant,
  SequenceMusicVariant,
} from './sequence-music-variants';

// Sequence exports (browser-rendered MP4 snapshots)
export { sequenceExports };

export type { NewSequenceExport, SequenceExport } from './sequence-exports';

// Characters (scripted roles)
export { characters };

export type {
  Character,
  CharacterMinimal,
  CharacterWithTalent,
  NewCharacter,
  SheetStatus,
} from './characters';

// Location Library (team-level templates)
export { locationLibrary };

export type { LibraryLocation, NewLibraryLocation } from './location-library';

// Sequence Locations (extracted from script)
export { sequenceLocations };

export type {
  NewSequenceLocation,
  ReferenceStatus,
  SequenceLocation,
  SequenceLocationMinimal,
} from './sequence-locations';

// Location Sheets (location-specific variations for library locations)
export { locationSheets };

export type { LocationSheet, NewLocationSheet } from './location-sheets';

// Sequence Elements (per-sequence uploaded reference images)
export { sequenceElements };

export type {
  ElementVisionStatus,
  NewSequenceElement,
  SequenceElement,
  SequenceElementMinimal,
} from './sequence-elements';

// Talent Library
export { talent, talentMedia, talentSheets };

export type {
  NewTalent,
  NewTalentMedia,
  NewTalentSheet,
  Talent,
  TalentMediaRecord,
  TalentSheet,
  TalentWithSheets,
} from './talent';

// Library Resources
export { audio, StyleConfigSchema, StyleSampleVideoSchema, styles, vfx };

export type { Audio, NewStyle, Style, StyleConfig, Vfx } from './libraries';

// Credits, Transactions, and Billing
export { credits, transactions };

/**
 * drizzle-kit only diffs TOP-LEVEL exported tables — tables reachable only
 * through the `schema` object below are treated as deleted and produce
 * DROP TABLE migrations (this bit us when the knip sweep removed these two).
 * Keep every table individually exported.
 *
 * @public used by drizzle-kit generate, not the app graph
 */
export { creditBatches, teamBillingSettings };

// Team API Keys
export { teamApiKeys };

export type { ApiKeyProvider } from './team-api-keys';

// Gift Tokens
export { giftTokens, giftTokenRedemptions };

// App Metadata (key/value bookkeeping, e.g. system-template seed hash)
export { appMetadata };

/**
 * Complete schema object for Drizzle client initialization (tables only).
 * Relations are defined separately in ./relations.ts using defineRelations().
 */
export const schema = {
  // Better Auth
  user,
  session,
  account,
  verification,
  passkey,
  apikey,

  // Teams
  teams,
  teamMembers,
  teamInvitations,

  // Sequences
  sequences,
  shots,
  shotVariants,
  characterSheetVariants,
  locationSheetVariants,
  talentSheetVariants,
  shotPromptVariants,
  sequenceMusicPromptVariants,
  sequenceMusicVariants,
  sequenceExports,

  // Characters (scripted roles extracted from script)
  characters,

  // Location Library (team-level templates)
  locationLibrary,

  // Sequence Locations (extracted from script)
  sequenceLocations,

  // Location Sheets (location-specific variations for library locations)
  locationSheets,

  // Sequence Elements (user-uploaded reference images)
  sequenceElements,

  // Talent Library
  talent,
  talentSheets,
  talentMedia,

  // Libraries
  styles,
  vfx,
  audio,

  // Credits & Billing
  credits,
  creditBatches,
  transactions,
  teamBillingSettings,

  // Team API Keys
  teamApiKeys,

  // Gift Tokens
  giftTokens,
  giftTokenRedemptions,

  // App Metadata
  appMetadata,
};
