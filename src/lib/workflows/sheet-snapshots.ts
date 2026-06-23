/**
 * Snapshot DTO hashers for content-generation workflows that opt into the
 * snapshot pattern.
 *
 * The `compute*FromDto` helpers hash the inlined payload; `compute*Current`
 * helpers re-resolve the upstream inputs from the live scoped DB so the
 * workflow can detect divergence at write-time.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § "Per-workflow input surface".
 */

import {
  computeCharacterSheetInputHash,
  computeShotImageInputHash,
  computeLocationSheetInputHash,
  computeTalentSheetInputHash,
  sha256Hex,
  type CharacterBibleHashFields,
  type ShotImageHashInput,
  type LocationBibleHashFields,
} from '@/lib/ai/input-hash';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { ScopedDb } from '@/lib/db/scoped';
import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
  StyleConfig,
} from '@/lib/db/schema';
import type {
  CharacterSheetWorkflowInput,
  ShotImageSceneSnapshot,
  ShotImagesWorkflowInput,
  LibraryTalentSheetWorkflowInput,
  LocationSheetWorkflowInput,
} from '@/lib/workflow/types';
import {
  matchCharactersToScene,
  matchElementsToScene,
  matchLocationsToScene,
} from './scene-matching';

export type { ShotImageSceneSnapshot } from '@/lib/workflow/types';

/**
 * Resolve the upstream talent-sheet's `input_hash` for a sequence character.
 * Returns `null` when the character has no talent assignment, when the talent
 * has no sheets, or when the sheet predates hash tracking.
 */
export async function resolveTalentSheetHash(
  scopedDb: ScopedDb,
  characterDbId: string
): Promise<string | null> {
  const character = await scopedDb.characters.getById(characterDbId);
  if (!character?.talentId) return null;
  const talent = await scopedDb.talent.getWithRelations(character.talentId);
  // Exclude divergent sheets from the fallback identity. A divergent row's
  // `inputHash` represents the parked workflow's snapshot, not the talent's
  // current upstream identity — binding a downstream character sheet to it
  // would fork off a stale lineage from first-time generation onward.
  const convergentSheets = talent?.sheets.filter((s) => !s.divergedAt) ?? [];
  const defaultSheet =
    convergentSheets.find((s) => s.isDefault) ?? convergentSheets[0];
  return defaultSheet?.inputHash ?? null;
}

/**
 * Resolve the parent library-location's `reference_input_hash` for a sequence
 * location. Returns `null` when the sequence location has no library
 * reference, or when the library row predates hash tracking.
 */
export async function resolveLibraryLocationReferenceHash(
  scopedDb: ScopedDb,
  locationDbId: string
): Promise<string | null> {
  const sequenceLocation =
    await scopedDb.sequenceLocations.getById(locationDbId);
  if (!sequenceLocation?.libraryLocationId) return null;
  const libraryLocation = await scopedDb.locations.getById(
    sequenceLocation.libraryLocationId
  );
  return libraryLocation?.referenceInputHash ?? null;
}

/** Hash a `StyleConfig` deterministically. `null`/`undefined` → 'no-style'. */
export async function computeStyleConfigHash(
  styleConfig: StyleConfig | null | undefined
): Promise<string> {
  if (!styleConfig) return 'no-style';
  return sha256Hex({
    artifact: 'style-config',
    mood: styleConfig.mood,
    artStyle: styleConfig.artStyle,
    lighting: styleConfig.lighting,
    colorPalette: styleConfig.colorPalette,
    cameraWork: styleConfig.cameraWork,
    referenceFilms: styleConfig.referenceFilms,
    colorGrading: styleConfig.colorGrading,
  });
}

function characterBibleFields(
  metadata: CharacterSheetWorkflowInput['characterMetadata']
): CharacterBibleHashFields {
  return {
    name: metadata.name,
    age: metadata.age,
    gender: metadata.gender,
    ethnicity: metadata.ethnicity,
    physicalDescription: metadata.physicalDescription,
    standardClothing: metadata.standardClothing,
    distinguishingFeatures: metadata.distinguishingFeatures,
    consistencyTag: metadata.consistencyTag,
  };
}

/**
 * Hash the character-sheet workflow payload. The `talentSheetInputHash` field
 * inlines the upstream talent-sheet's `input_hash` so that a recast triggered
 * against a then-current talent sheet binds to that exact upstream version.
 */
export async function computeCharacterSheetHashFromDto(
  input: CharacterSheetWorkflowInput & { talentSheetInputHash?: string | null }
): Promise<string> {
  return computeCharacterSheetInputHash({
    characterBible: characterBibleFields(input.characterMetadata),
    talentSheetHash: input.talentSheetInputHash ?? null,
    styleConfigHash: await computeStyleConfigHash(input.styleConfig),
    imageModel: input.imageModel ?? DEFAULT_IMAGE_MODEL,
  });
}

/**
 * Recompute the hash from the current DB state. The character bible, style
 * config, and image model are frozen on the payload (they must not drift
 * mid-flight); we re-read the upstream talent sheet's `input_hash` since
 * that's the only upstream entity whose hash can change between trigger and
 * write.
 */
export async function computeCharacterSheetHashCurrent(
  input: CharacterSheetWorkflowInput,
  scopedDb: ScopedDb
): Promise<string> {
  const talentSheetInputHash = await resolveTalentSheetHash(
    scopedDb,
    input.characterDbId
  );
  return computeCharacterSheetHashFromDto({ ...input, talentSheetInputHash });
}

function locationBibleFields(
  metadata: LocationSheetWorkflowInput['locationMetadata']
): LocationBibleHashFields {
  return {
    name: metadata.name,
    description: metadata.description,
  };
}

/**
 * Hash the location-sheet workflow payload. `libraryLocationReferenceHash`
 * inlines the parent library location's `reference_input_hash` if the sheet
 * was triggered with a library reference; otherwise `null`.
 */
export async function computeLocationSheetHashFromDto(
  input: LocationSheetWorkflowInput & {
    libraryLocationReferenceHash?: string | null;
  }
): Promise<string> {
  return computeLocationSheetInputHash({
    locationBible: locationBibleFields(input.locationMetadata),
    libraryLocationReferenceHash: input.libraryLocationReferenceHash ?? null,
    styleConfigHash: await computeStyleConfigHash(input.styleConfig),
    imageModel: input.imageModel ?? DEFAULT_IMAGE_MODEL,
  });
}

export async function computeLocationSheetHashCurrent(
  input: LocationSheetWorkflowInput,
  scopedDb: ScopedDb
): Promise<string> {
  const libraryLocationReferenceHash =
    await resolveLibraryLocationReferenceHash(scopedDb, input.locationDbId);
  return computeLocationSheetHashFromDto({
    ...input,
    libraryLocationReferenceHash,
  });
}

/**
 * Library talent sheets are content-addressed by the inlined reference URLs:
 * talent media is append-only in practice, so the snapshot is the URL set
 * itself. We hash via `computeTalentSheetInputHash` keyed on those URLs as
 * the reference-media identity (no external `media_id` lookup required).
 */
export async function computeLibraryTalentSheetHashFromDto(
  input: LibraryTalentSheetWorkflowInput
): Promise<string> {
  // Sort here so callers that forget to pre-sort get a stable hash. The
  // `Current` helper sorts the live media URLs the same way; without sorting
  // here, an unsorted DTO would diverge against a sorted DB read on every run.
  const referenceMediaHashes = [...(input.referenceImageUrls ?? [])].sort();
  return computeTalentSheetInputHash({
    talent: {
      name: input.talentName,
      description: input.talentDescription ?? null,
    },
    referenceMediaHashes,
    imageModel: input.imageModel ?? DEFAULT_IMAGE_MODEL,
  });
}

export async function computeLibraryTalentSheetHashCurrent(
  input: LibraryTalentSheetWorkflowInput,
  scopedDb: ScopedDb
): Promise<string> {
  const talent = await scopedDb.talent.getWithRelations(input.talentId);
  // Fall back to the payload list when the talent row vanished mid-flight —
  // the workflow will fail downstream on the missing record, but we shouldn't
  // mask the divergence check with a noisy lookup error here.
  const currentImageUrls =
    talent?.media
      .filter((m) => m.type === 'image')
      .map((m) => m.url)
      .sort() ??
    input.referenceImageUrls ??
    [];
  return computeLibraryTalentSheetHashFromDto({
    ...input,
    referenceImageUrls: currentImageUrls,
  });
}

/** Drop nulls/empties and sort so order-insensitive comparisons match. */
function sortedRefHashes(values: Array<string | null | undefined>): string[] {
  return values
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort();
}

/**
 * Match a scene's referenced characters / locations / elements from live DB
 * rows and resolve the three reference-hash sets that feed the shot-image
 * input hash: character `sheetInputHash`, location `referenceInputHash`, and
 * element `imageUrl`.
 *
 * Single source of truth so the image-generation **stamp**
 * (`computeImageWorkflowHashCurrent`) and the staleness **verify**
 * (`buildRegenerateShotSnapshot`) cannot drift — drift on the element /
 * location sets (verify hard-coded them to `[]` and used a different location
 * matcher) made every element- or location-bearing shot report permanently
 * "Inputs changed". See #867.
 */
export function resolveSceneShotImageReferences(params: {
  // Structural (not `Scene`) so it accepts both the strict scene and the
  // looser `shot.metadata` shapes callers hold; only these fields are read.
  scene: {
    continuity?: {
      characterTags?: string[];
      environmentTag?: string;
      elementTags?: string[] | null;
    } | null;
    metadata?: { location?: string } | null;
    originalScript?: { extract?: string } | null;
  } | null;
  characters: CharacterMinimal[];
  locations: SequenceLocationMinimal[];
  elements: SequenceElementMinimal[];
}): {
  characters: CharacterMinimal[];
  locations: SequenceLocationMinimal[];
  elements: SequenceElementMinimal[];
  characterSheetHashes: string[];
  locationSheetHashes: string[];
  elementReferenceHashes: string[];
} {
  const { scene, characters, locations, elements } = params;
  const matchedCharacters = matchCharactersToScene(
    characters,
    scene?.continuity?.characterTags ?? []
  );
  const matchedLocations = matchLocationsToScene(
    locations,
    scene?.continuity?.environmentTag ?? '',
    scene?.metadata?.location ?? ''
  );
  const matchedElements = matchElementsToScene(
    elements,
    scene?.continuity?.elementTags ?? [],
    scene?.originalScript?.extract ?? ''
  );
  return {
    characters: matchedCharacters,
    locations: matchedLocations,
    elements: matchedElements,
    characterSheetHashes: sortedRefHashes(
      matchedCharacters.map((c) => c.sheetInputHash)
    ),
    locationSheetHashes: sortedRefHashes(
      matchedLocations.map((l) => l.referenceInputHash)
    ),
    elementReferenceHashes: sortedRefHashes(
      matchedElements.map((e) => e.imageUrl)
    ),
  };
}

/**
 * Hash one scene's snapshot — used to populate `thumbnail_input_hash` on the
 * shot row and `input_hash` on the matching primary `shot_variants` row.
 */
export function computeShotImageSceneHash(
  scene: ShotImageSceneSnapshot,
  imageModel: string,
  aspectRatio: string
): Promise<string> {
  const hashInput: ShotImageHashInput = {
    kind: 'thumbnail',
    visualPrompt: scene.visualPrompt,
    imageModel,
    aspectRatio,
    characterSheetHashes: scene.characterSheetHashes,
    locationSheetHashes: scene.locationSheetHashes,
    elementReferenceHashes: scene.elementReferenceHashes,
  };
  return computeShotImageInputHash(hashInput);
}

/**
 * Hash the full shot-images payload. Binds every scene snapshot — including
 * the upstream sheet hashes alongside each URL — so a payload that preserves
 * only `snapshotInputHash` cannot smuggle replaced reference images past
 * validation.
 */
export async function computeShotImagesHashFromDto(
  input: ShotImagesWorkflowInput & {
    sceneSnapshots: ShotImageSceneSnapshot[];
  }
): Promise<string> {
  return sha256Hex({
    artifact: 'shot-images:batch',
    sequenceId: input.sequenceId ?? null,
    imageModel: input.imageModel ?? null,
    imageModels: input.imageModels ?? null,
    aspectRatio: input.aspectRatio,
    scenes: [...input.sceneSnapshots].sort((a, b) =>
      a.sceneId.localeCompare(b.sceneId)
    ),
  });
}
