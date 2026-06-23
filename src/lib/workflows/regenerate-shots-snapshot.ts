/**
 * Snapshot DTO builders + hashers for `regenerateFramesWorkflow`.
 *
 * The workflow opts into the snapshot pattern (see
 * docs/architecture/workflow-snapshots-and-content-hash-staleness.md):
 * a per-frame DTO is resolved at trigger time, hashed, and inlined into the
 * QStash payload. Here we own (1) building the per-frame DTO from the live
 * scoped DB and (2) computing the batch hash that gates the start-time
 * tamper check.
 */

import {
  computeFrameImageInputHash,
  sha256Hex,
  type FrameImageHashInput,
} from '@/lib/ai/input-hash';
import type { TextToImageModel } from '@/lib/ai/models';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import type {
  Character,
  Shot,
  NewShot,
  NewShotVariant,
  SequenceElement,
  SequenceLocation,
} from '@/lib/db/schema';
import { buildDivergentRevertWrites } from './divergence-writes';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import type {
  RegenerateShotSnapshot,
  RegenerateShotsWorkflowInput,
} from '@/lib/workflow/types';
import { resolveSceneFrameImageReferences } from './sheet-snapshots';

/**
 * Build one frame's snapshot DTO from the live scoped state. Used at trigger
 * time and (with current-state inputs) at write time for divergence checks.
 */
export async function buildRegenerateShotSnapshot(params: {
  frame: Pick<Shot, 'id' | 'imagePrompt' | 'metadata'>;
  characters: Character[];
  locations: SequenceLocation[];
  elements: SequenceElement[];
  imageModel: TextToImageModel;
  aspectRatio: AspectRatio;
}): Promise<RegenerateShotSnapshot> {
  const { frame, characters, locations, elements, imageModel, aspectRatio } =
    params;

  // Effective prompt: user-override column wins over the AI-generated prompt
  // stored in scene metadata. Both sites must read this same fallback chain
  // so a `visualPromptSceneWorkflow` regen (which only updates metadata)
  // produces a different hash than the prior thumbnail's stored hash. See #713
  // for the longer-term single-source-of-truth refactor.
  const effectivePrompt =
    frame.imagePrompt || frame.metadata?.prompts?.visual?.fullPrompt;

  // Reject empty prompts at the snapshot boundary so trigger-time data
  // errors fail loudly at the call site instead of being absorbed as
  // per-frame failures inside the workflow.
  if (!effectivePrompt || effectivePrompt.length === 0) {
    throw new Error(`Frame ${frame.id} has no visual prompt; cannot snapshot`);
  }

  // Resolve the scene's character / location / element references exactly the
  // way image generation does (`computeImageWorkflowHashCurrent`) — same
  // matchers, same reference-hash sets — so this verify-time hash equals the
  // thumbnail hash stamped at generation. Omitting the element/location sets
  // here made every product-/location-bearing frame report stale. See #867.
  const refs = resolveSceneFrameImageReferences({
    scene: frame.metadata,
    characters,
    locations,
    elements,
  });

  const characterRefs = buildCharacterReferenceImages(refs.characters);
  const locationRefs = buildLocationReferenceImages(refs.locations);

  const hashInput: FrameImageHashInput = {
    kind: 'thumbnail',
    visualPrompt: effectivePrompt,
    imageModel,
    aspectRatio,
    characterSheetHashes: refs.characterSheetHashes,
    locationSheetHashes: refs.locationSheetHashes,
    elementReferenceHashes: refs.elementReferenceHashes,
  };

  const snapshotInputHash = await computeFrameImageInputHash(hashInput);

  return {
    shotId: frame.id,
    imagePrompt: effectivePrompt,
    characterSheetHashes: refs.characterSheetHashes,
    locationSheetHashes: refs.locationSheetHashes,
    elementReferenceHashes: refs.elementReferenceHashes,
    characterRefs,
    locationRefs,
    snapshotInputHash,
  };
}

/**
 * Hash the full inlined DTO for the start-time tamper check. Binds every
 * field consumed by the workflow body — including the resolved `characterRefs`
 * and `locationRefs` URLs — so a payload that preserves only `snapshotInputHash`
 * cannot smuggle replaced reference images past validation.
 */
export async function computeRegenerateShotsBatchHash(
  input: Pick<
    RegenerateShotsWorkflowInput,
    'aspectRatio' | 'imageModel' | 'frameSnapshots' | 'sequenceId'
  >
): Promise<string> {
  return sha256Hex({
    artifact: 'regenerate-frames:batch',
    sequenceId: input.sequenceId ?? null,
    imageModel: input.imageModel ?? null,
    aspectRatio: input.aspectRatio,
    shots: [...input.frameSnapshots].sort((a, b) =>
      a.shotId < b.shotId ? -1 : 1
    ),
  });
}

type RecastEventPayload =
  | { event: 'start'; triggerId: string; frameCount: number }
  | {
      event: 'complete';
      triggerId: string;
      successCount: number;
      failedCount: number;
    }
  | { event: 'failed'; triggerId: string; error: string };

/**
 * Emit a recast lifecycle event on the channel that matches the triggering
 * entity. Character recasts go to `recast:*` (keyed by characterId);
 * location recasts go to `recast-location:*` (keyed by locationId). The
 * workflow body does not know which channel to use without this helper —
 * `triggeringCharacterId` was the original (incorrect) overload.
 */
export async function emitRecastEvent(
  args: {
    kind: 'character' | 'location';
    sequenceId: string;
  } & RecastEventPayload
): Promise<void> {
  const channel = getGenerationChannel(args.sequenceId);
  if (args.kind === 'character') {
    if (args.event === 'start') {
      await channel.emit('generation.recast:start', {
        characterId: args.triggerId,
        frameCount: args.frameCount,
      });
      return;
    }
    if (args.event === 'complete') {
      await channel.emit('generation.recast:complete', {
        characterId: args.triggerId,
        successCount: args.successCount,
        failedCount: args.failedCount,
      });
      return;
    }
    await channel.emit('generation.recast:failed', {
      characterId: args.triggerId,
      error: args.error,
    });
    return;
  }
  if (args.event === 'start') {
    await channel.emit('generation.recast-location:start', {
      locationId: args.triggerId,
      frameCount: args.frameCount,
    });
    return;
  }
  if (args.event === 'complete') {
    await channel.emit('generation.recast-location:complete', {
      locationId: args.triggerId,
      successCount: args.successCount,
      failedCount: args.failedCount,
    });
    return;
  }
  await channel.emit('generation.recast-location:failed', {
    locationId: args.triggerId,
    error: args.error,
  });
}

/**
 * Writes to apply when the per-frame hash matches between trigger and write
 * time. `image-workflow` already wrote the primary; record the input-hash on
 * both rows so downstream staleness reads compare against this snapshot.
 */
export function buildConvergentWrites(snapshotInputHash: string): {
  frame: Partial<NewShot>;
  variant: Partial<NewShotVariant>;
} {
  return {
    frame: { thumbnailInputHash: snapshotInputHash },
    variant: { inputHash: snapshotInputHash, divergedAt: null },
  };
}

/**
 * `divergentRow` is a partial payload for an INSERT that preserves the
 * diverged result as an alternate. The workflow supplies shotId, sequenceId,
 * variantType, model, and the speculative url; this helper supplies the
 * divergence-specific fields so the alternate is identifiable in the
 * divergent partial unique index.
 */
export function buildDivergentWrites(
  snapshotInputHash: string,
  divergedAt: Date
): {
  frame: Partial<NewShot>;
  primaryRevert: Partial<NewShotVariant>;
  divergentRow: Partial<NewShotVariant> & {
    inputHash: string;
    divergedAt: Date;
  };
} {
  return {
    ...buildDivergentRevertWrites(),
    divergentRow: {
      inputHash: snapshotInputHash,
      divergedAt,
      status: 'completed',
    },
  };
}
