/**
 * Builds the per-frame `ImageWorkflowInput` for an image generation — the
 * reference-image attachment + per-scene snapshot hash that both the
 * single-frame regenerate (`generateShotImageFn`) and the bulk add-model
 * (`addModelToSequenceFn`, #547) paths need. Extracted so the two callers stay
 * consistent: same prompt fallback chain, same character/location/element
 * matching, same snapshot hash.
 */

import type { TextToImageModel } from '@/lib/ai/models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type {
  CharacterMinimal,
  Shot,
  SequenceElement,
  SequenceLocation,
} from '@/lib/db/schema';
import { locationMatchesTag } from '@/lib/db/scoped/sequence-locations';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildElementReferenceImages } from '@/lib/prompts/element-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type {
  FrameImageSceneSnapshot,
  ImageWorkflowInput,
} from '@/lib/workflow/types';
import {
  matchCharactersToScene,
  matchElementsToScene,
  matchLocationsToScene,
} from '@/lib/workflows/scene-matching';
import { computeFrameImageSceneHash } from '@/lib/workflows/sheet-snapshots';

function sortedHashes(
  values: ReadonlyArray<string | null | undefined>
): string[] {
  return values
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort();
}

/** Match locations by environmentTag or scene location and return reference images. */
function getSceneLocationReferenceImages(
  allLocations: SequenceLocation[],
  environmentTag: string,
  sceneLocation: string
) {
  if (!environmentTag && !sceneLocation) return [];
  const matched = allLocations.filter(
    (loc) =>
      (environmentTag && locationMatchesTag(loc, environmentTag)) ||
      (sceneLocation && locationMatchesTag(loc, sceneLocation))
  );
  return buildLocationReferenceImages(matched);
}

export async function buildFrameImageWorkflowInput(opts: {
  frame: Shot;
  model: TextToImageModel;
  userId: string;
  teamId: string;
  sequenceId: string;
  aspectRatio: AspectRatio;
  characters: CharacterMinimal[];
  locations: SequenceLocation[];
  elements: SequenceElement[];
  /**
   * Continuity to match references against. Defaults to the frame's stored
   * continuity; callers that just edited a prompt pass a rescanned one.
   */
  continuity?: Scene['continuity'];
  /** Prompt override (e.g. a user edit). Defaults to the frame's prompt chain. */
  prompt?: string;
  userEditedPrompt?: boolean;
  /**
   * Variant-only (#547): the resulting `/image` run writes only this model's
   * `frame_variants` row, never the primary columns. Set by the add-model path.
   */
  variantOnly?: boolean;
}): Promise<ImageWorkflowInput | null> {
  const {
    frame,
    model,
    userId,
    teamId,
    sequenceId,
    aspectRatio,
    characters,
    locations,
    elements,
  } = opts;

  // Priority: provided > stored > AI-generated > description.
  const prompt =
    opts.prompt ||
    frame.imagePrompt ||
    frame.metadata?.prompts?.visual?.fullPrompt ||
    frame.description;
  if (!prompt) return null;

  const continuity = opts.continuity ?? frame.metadata?.continuity;

  const matchedCharacters = matchCharactersToScene(
    characters,
    continuity?.characterTags ?? []
  );
  const characterReferences = buildCharacterReferenceImages(matchedCharacters);

  const environmentTag = continuity?.environmentTag ?? '';
  const sceneLocation = frame.metadata?.metadata?.location ?? '';
  const matchedLocations = matchLocationsToScene(
    locations,
    environmentTag,
    sceneLocation
  );
  const locationReferences = getSceneLocationReferenceImages(
    locations,
    environmentTag,
    sceneLocation
  );

  const matchedElements = matchElementsToScene(
    elements,
    continuity?.elementTags ?? [],
    frame.metadata?.originalScript.extract ?? ''
  );
  const elementReferences = buildElementReferenceImages(matchedElements);

  const sceneSnapshot: FrameImageSceneSnapshot = {
    sceneId: frame.metadata?.sceneId ?? frame.id,
    visualPrompt: prompt,
    characterSheetHashes: sortedHashes(
      matchedCharacters.map((c) => c.sheetInputHash)
    ),
    locationSheetHashes: sortedHashes(
      matchedLocations.map((l) => l.referenceInputHash)
    ),
    elementReferenceHashes: sortedHashes(
      matchedElements.map((e) => e.imageUrl)
    ),
  };
  const snapshotInputHash = await computeFrameImageSceneHash(
    sceneSnapshot,
    model,
    aspectRatio
  );

  return {
    userId,
    teamId,
    prompt,
    model,
    imageSize: aspectRatioToImageSize(aspectRatio),
    numImages: 1,
    shotId: frame.id,
    sequenceId,
    aspectRatio,
    sceneSnapshot,
    snapshotInputHash,
    referenceImages: [
      ...characterReferences,
      ...locationReferences,
      ...elementReferences,
    ],
    userEditedPrompt: opts.userEditedPrompt ?? false,
    variantOnly: opts.variantOnly ?? false,
  };
}
