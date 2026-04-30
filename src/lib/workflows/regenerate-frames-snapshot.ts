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
  Frame,
  NewFrame,
  NewFrameVariant,
  SequenceLocation,
} from '@/lib/db/schema';
import { matchLocationsToFrame } from '@/lib/db/scoped/sequence-locations';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import type {
  RegenerateFrameSnapshot,
  RegenerateFramesWorkflowInput,
} from '@/lib/workflow/types';
import { matchCharactersToScene } from './scene-matching';

/** Drop nulls and sort so order-insensitive comparisons match. */
function collectSortedHashes(
  hashes: Array<string | null | undefined>
): string[] {
  return hashes
    .filter((h): h is string => typeof h === 'string' && h.length > 0)
    .sort();
}

/**
 * Build one frame's snapshot DTO from the live scoped state. Used at trigger
 * time and (with current-state inputs) at write time for divergence checks.
 */
export async function buildRegenerateFrameSnapshot(params: {
  frame: Pick<Frame, 'id' | 'imagePrompt' | 'metadata'>;
  characters: Character[];
  locations: SequenceLocation[];
  imageModel: TextToImageModel;
  aspectRatio: AspectRatio;
}): Promise<RegenerateFrameSnapshot> {
  const { frame, characters, locations, imageModel, aspectRatio } = params;

  // Reject empty prompts at the snapshot boundary so trigger-time data
  // errors fail loudly at the call site instead of being absorbed as
  // per-frame failures inside the workflow.
  if (!frame.imagePrompt || frame.imagePrompt.length === 0) {
    throw new Error(`Frame ${frame.id} has no imagePrompt; cannot snapshot`);
  }

  const characterTags = frame.metadata?.continuity?.characterTags ?? [];
  const frameCharacters = matchCharactersToScene(characters, characterTags);
  const frameLocations = matchLocationsToFrame(frame, locations);

  const characterSheetHashes = collectSortedHashes(
    frameCharacters.map((c) => c.sheetInputHash)
  );
  // `sequence_locations` does not yet carry its own input_hash column (Stage 1
  // put hashes on `location_sheets` and `locationLibrary`). For now we skip
  // them — character-recast divergence is the headline case this PR proves
  // out, and sequence-location hashes drop in here without other changes
  // when that column lands.
  const locationSheetHashes: string[] = [];

  const characterRefs = buildCharacterReferenceImages(frameCharacters);
  const locationRefs = buildLocationReferenceImages(frameLocations);

  const hashInput: FrameImageHashInput = {
    kind: 'thumbnail',
    visualPrompt: frame.imagePrompt,
    imageModel,
    aspectRatio,
    characterSheetHashes,
    locationSheetHashes,
    elementReferenceHashes: [],
  };

  const snapshotInputHash = await computeFrameImageInputHash(hashInput);

  return {
    frameId: frame.id,
    imagePrompt: frame.imagePrompt,
    characterSheetHashes,
    locationSheetHashes,
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
export async function computeRegenerateFramesBatchHash(
  input: Pick<
    RegenerateFramesWorkflowInput,
    'aspectRatio' | 'imageModel' | 'frameSnapshots' | 'sequenceId'
  >
): Promise<string> {
  return sha256Hex({
    artifact: 'regenerate-frames:batch',
    sequenceId: input.sequenceId ?? null,
    imageModel: input.imageModel ?? null,
    aspectRatio: input.aspectRatio,
    frames: [...input.frameSnapshots].sort((a, b) =>
      a.frameId < b.frameId ? -1 : 1
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
  frame: Partial<NewFrame>;
  variant: Partial<NewFrameVariant>;
} {
  return {
    frame: { thumbnailInputHash: snapshotInputHash },
    variant: { inputHash: snapshotInputHash, divergedAt: null },
  };
}

/**
 * Writes to apply when current inputs no longer match the snapshot.
 *
 *   - `frame`: revert the speculative primary thumbnail on the frame row
 *     back to `pending` so the next reconciliation regenerates from current
 *     inputs.
 *   - `primaryRevert`: clear the speculative URL/status that image-workflow
 *     pre-wrote to the primary variant row, so the primary slot stops
 *     pointing at diverged work.
 *   - `divergentRow`: partial payload for an INSERT that preserves the
 *     diverged result as an alternate. The workflow supplies frameId,
 *     sequenceId, variantType, model, and the speculative url; this helper
 *     supplies the divergence-specific fields so the alternate is
 *     identifiable in the divergent partial unique index.
 */
export function buildDivergentWrites(
  snapshotInputHash: string,
  divergedAt: Date
): {
  frame: Partial<NewFrame>;
  primaryRevert: Partial<NewFrameVariant>;
  divergentRow: Partial<NewFrameVariant> & {
    inputHash: string;
    divergedAt: Date;
  };
} {
  return {
    frame: {
      thumbnailUrl: null,
      thumbnailPath: null,
      thumbnailStatus: 'pending',
      thumbnailWorkflowRunId: null,
      thumbnailGeneratedAt: null,
      thumbnailError: null,
      thumbnailInputHash: null,
    },
    primaryRevert: {
      url: null,
      storagePath: null,
      previewUrl: null,
      status: 'pending',
      workflowRunId: null,
      generatedAt: null,
      error: null,
      inputHash: null,
    },
    divergentRow: {
      inputHash: snapshotInputHash,
      divergedAt,
      status: 'completed',
    },
  };
}
