/**
 * Drizzle ORM Schema Index
 * Central export point for all database schemas.
 *
 * Relations are defined separately in ./relations.ts using defineRelations()
 * (Drizzle Relations v2 — single consolidated definition, no per-table relations() calls).
 */

import { account, passkey, session, user, verification } from './auth';

import { teamInvitations, teamMembers, teams } from './teams';

import { sequences } from './sequences';

import { frames } from './frames';

import { frameVariants } from './frame-variants';

import { characters } from './characters';

// Location Library (team-level templates)
import { locationLibrary } from './location-library';

// Sequence Locations (script-extracted)
import { sequenceLocations } from './sequence-locations';

import { locationSheets } from './location-sheets';

// Sequence Elements (user-uploaded reference images)
import { sequenceElements } from './sequence-elements';

import { talent, talentMedia, talentSheets } from './talent';

import { audio, StyleConfigSchema, styles, vfx } from './libraries';

import {
  creditBatches,
  credits,
  teamBillingSettings,
  transactions,
} from './credits';

import { teamApiKeys } from './team-api-keys';

import { giftTokenRedemptions, giftTokens } from './gift-tokens';

// Better Auth tables
export { account, passkey, session, user, verification };

export type { Account, Passkey, Session, User, Verification } from './auth';

// Teams
export { teamInvitations, teamMembers, teams };

export type {
  InvitationStatus,
  NewTeam,
  NewTeamInvitation,
  NewTeamMember,
  Team,
  TeamInvitation,
  TeamMember,
  TeamMemberRole,
} from './teams';

// Sequences
export { sequences };

export type { NewSequence, Sequence, SequenceStatus } from './sequences';

// Frames
export { frames };

export type { Frame, NewFrame } from './frames';

// Frame Variants
export { frameVariants };

export type {
  FrameVariant,
  NewFrameVariant,
  VariantType,
} from './frame-variants';

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

export type {
  LibraryLocation,
  LibraryLocationMinimal,
  NewLibraryLocation,
} from './location-library';

// Sequence Locations (extracted from script)
export { sequenceLocations };

export type {
  NewSequenceLocation,
  ReferenceStatus,
  SequenceLocation,
  SequenceLocationMinimal,
  SequenceLocationWithDetails,
} from './sequence-locations';

// Location Sheets (location-specific variations for library locations)
export { locationSheets };

export type {
  LocationSheet,
  LocationSheetSource,
  NewLocationSheet,
} from './location-sheets';

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
  TalentMediaType,
  TalentSheet,
  TalentSheetSource,
  TalentWithRelations,
  TalentWithSheets,
} from './talent';

// Library Resources
export { audio, StyleConfigSchema, styles, vfx };

export type {
  Audio,
  NewAudio,
  NewStyle,
  NewVfx,
  Style,
  StyleConfig,
  Vfx,
} from './libraries';

// Credits, Transactions, and Billing
export { creditBatches, credits, transactions, teamBillingSettings };

export type {
  Credit,
  CreditBatch,
  CreditBatchSource,
  NewCredit,
  NewCreditBatch,
  NewTeamBillingSetting,
  NewTransaction,
  TeamBillingSetting,
  Transaction,
  TransactionType,
} from './credits';

// Team API Keys
export { teamApiKeys };

export type {
  ApiKeyProvider,
  ApiKeySource,
  NewTeamApiKey,
  TeamApiKey,
} from './team-api-keys';

// Gift Tokens
export { giftTokens, giftTokenRedemptions };

export type {
  GiftToken,
  GiftTokenRedemption,
  NewGiftToken,
  NewGiftTokenRedemption,
} from './gift-tokens';

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

  // Teams
  teams,
  teamMembers,
  teamInvitations,

  // Sequences
  sequences,
  frames,
  frameVariants,

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
};
