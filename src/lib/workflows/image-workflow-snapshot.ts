/**
 * Snapshot DTO hashers + persist orchestration for `generateImageWorkflow`.
 *
 * `computeFromDto` hashes the inlined per-scene snapshot for the start-time
 * tamper check. `computeCurrent` re-resolves the live character / location /
 * element sheet hashes from the scoped DB so the workflow can detect upstream
 * drift between trigger and write time and route divergent results into
 * `frame_variants` instead of overwriting the primary thumbnail.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § "Pillar 3: Divergence-on-completion".
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type {
  CharacterMinimal,
  NewFrame,
  NewFrameVariant,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/lib/db/schema';
import type { VariantType } from '@/lib/db/schema/frame-variants';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  FrameImageSceneSnapshot,
  ImageWorkflowInput,
} from '@/lib/workflow/types';
import { buildDivergentRevertWrites } from './divergence-writes';
import { computeFrameImageSceneHash } from './sheet-snapshots';
import {
  matchCharactersToScene,
  matchElementsToScene,
  matchLocationsToScene,
} from './scene-matching';

export type ImageStorageResult = { url: string; path: string };

/**
 * Subset of `Scene` actually read by `computeImageWorkflowHashCurrent` —
 * keeping the narrow shape declared here so production `Scene` (a superset)
 * assigns cleanly while test stubs can build small literals.
 */
export type SceneForHash = {
  continuity?: {
    characterTags?: string[];
    environmentTag?: string;
    elementTags?: string[];
  } | null;
  metadata?: { location?: string } | null;
  originalScript?: { extract?: string } | null;
};

/**
 * Minimum scopedDb surface for `computeImageWorkflowHashCurrent`. Production
 * `ScopedDb` is a structural superset and assigns cleanly; tests can build
 * literal objects against this type without casting.
 */
export type ImageHashScopedDb = {
  frames: {
    getById: (id: string) => Promise<{ metadata: SceneForHash | null } | null>;
  };
  characters: {
    listWithSheets: (seqId: string) => Promise<CharacterMinimal[]>;
  };
  sequenceLocations: {
    listWithReferences: (seqId: string) => Promise<SequenceLocationMinimal[]>;
  };
  sequenceElements: {
    list: (seqId: string) => Promise<SequenceElementMinimal[]>;
  };
};

/**
 * Minimum scopedDb surface for `persistImageResult`. Same pattern as
 * `ImageHashScopedDb` — production `ScopedDb` satisfies it structurally.
 */
export type PersistImageScopedDb = {
  frames: {
    update: (
      id: string,
      data: Partial<NewFrame>,
      opts?: { throwOnMissing?: boolean }
    ) => Promise<{ id: string } | undefined>;
  };
  frameVariants: {
    updateByFrameAndModel: (
      frameId: string,
      type: VariantType,
      model: string,
      data: Partial<NewFrameVariant>
    ) => Promise<{ id: string } | null>;
    insertDivergent: (
      data: NewFrameVariant & { inputHash: string; divergedAt: Date }
    ) => Promise<{ id: string }>;
  };
};

const NO_SNAPSHOT_SENTINEL = '';

function sortedHashes(values: Array<string | null | undefined>): string[] {
  return values
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort();
}

function requireAspectRatio(
  input: ImageWorkflowInput
): NonNullable<ImageWorkflowInput['aspectRatio']> {
  if (!input.aspectRatio) {
    throw new WorkflowValidationError(
      'aspectRatio is required when sceneSnapshot is present; trigger-time and write-time hashes would otherwise diverge'
    );
  }
  return input.aspectRatio;
}

export function computeImageWorkflowHashFromDto(
  input: ImageWorkflowInput
): Promise<string> | string {
  if (!input.sceneSnapshot) {
    return input.snapshotInputHash ?? NO_SNAPSHOT_SENTINEL;
  }
  return computeFrameImageSceneHash(
    input.sceneSnapshot,
    input.model ?? DEFAULT_IMAGE_MODEL,
    requireAspectRatio(input)
  );
}

export async function computeImageWorkflowHashCurrent(
  input: ImageWorkflowInput,
  scopedDb: ImageHashScopedDb
): Promise<string> {
  if (!input.sceneSnapshot)
    return input.snapshotInputHash ?? NO_SNAPSHOT_SENTINEL;

  const model = input.model ?? DEFAULT_IMAGE_MODEL;
  const aspectRatio = requireAspectRatio(input);

  if (!input.sequenceId || !input.frameId) {
    return computeFrameImageSceneHash(input.sceneSnapshot, model, aspectRatio);
  }

  const frame = await scopedDb.frames.getById(input.frameId);
  // Deleted mid-flight: collapse to convergent so the workflow's
  // deleted-frame short-circuit handles the cleanup. Distinct from a frame
  // that exists with null metadata, which is data corruption — refuse.
  if (!frame) {
    return computeFrameImageSceneHash(input.sceneSnapshot, model, aspectRatio);
  }
  if (!frame.metadata) {
    throw new WorkflowValidationError(
      `Frame ${input.frameId} exists but has null metadata; snapshot recompute requires scene metadata`
    );
  }

  const [characters, locations, elements] = await Promise.all([
    scopedDb.characters.listWithSheets(input.sequenceId),
    scopedDb.sequenceLocations.listWithReferences(input.sequenceId),
    scopedDb.sequenceElements.list(input.sequenceId),
  ]);

  const scene = frame.metadata;
  const matchedCharacters = matchCharactersToScene(
    characters,
    scene.continuity?.characterTags ?? []
  );
  const matchedLocations = matchLocationsToScene(
    locations,
    scene.continuity?.environmentTag ?? '',
    scene.metadata?.location ?? ''
  );
  const matchedElements = matchElementsToScene(
    elements,
    scene.continuity?.elementTags ?? [],
    scene.originalScript?.extract ?? ''
  );

  const currentSnapshot: FrameImageSceneSnapshot = {
    sceneId: input.sceneSnapshot.sceneId,
    visualPrompt: input.sceneSnapshot.visualPrompt,
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

  return computeFrameImageSceneHash(currentSnapshot, model, aspectRatio);
}

/**
 * Convergent write also clears `variant.previewUrl` so a prior preview-mode
 * run can't leave a stale preview pointer attached to the converged primary.
 * Resets video lifecycle because a new thumbnail invalidates dependent motion.
 */
export function buildImageConvergentWrites(opts: {
  upload: ImageStorageResult;
  snapshotHash: string | null;
  promptHash: string | null;
  generatedAt: Date;
}): {
  frame: Partial<NewFrame>;
  variant: Partial<NewFrameVariant>;
} {
  const { upload, snapshotHash, promptHash, generatedAt } = opts;
  return {
    frame: {
      thumbnailPath: upload.path,
      thumbnailUrl: upload.url,
      thumbnailStatus: 'completed',
      thumbnailGeneratedAt: generatedAt,
      thumbnailError: null,
      thumbnailInputHash: snapshotHash,
      videoUrl: null,
      videoPath: null,
      videoStatus: 'pending',
      videoWorkflowRunId: null,
      videoGeneratedAt: null,
      videoError: null,
    },
    variant: {
      url: upload.url,
      storagePath: upload.path,
      previewUrl: null,
      status: 'completed',
      generatedAt,
      error: null,
      promptHash,
      inputHash: snapshotHash,
    },
  };
}

/**
 * `divergentRow` is the full INSERT payload for the divergent alternate. The
 * caller supplies frameId/sequenceId/variantType/model; this helper supplies
 * the content fields including the `inputHash` + `divergedAt` keys that match
 * the `frame_variants` divergent partial unique index.
 */
export function buildImageDivergentWrites(opts: {
  upload: ImageStorageResult;
  snapshotHash: string;
  promptHash: string | null;
  divergedAt: Date;
}): {
  frame: Partial<NewFrame>;
  primaryRevert: Partial<NewFrameVariant>;
  divergentRow: Partial<NewFrameVariant> & {
    url: string;
    storagePath: string;
    inputHash: string;
    divergedAt: Date;
    status: 'completed';
  };
} {
  const { upload, snapshotHash, promptHash, divergedAt } = opts;
  return {
    ...buildDivergentRevertWrites(),
    divergentRow: {
      url: upload.url,
      storagePath: upload.path,
      status: 'completed',
      generatedAt: divergedAt,
      error: null,
      promptHash,
      inputHash: snapshotHash,
      divergedAt,
    },
  };
}

export type PersistImageOutcome =
  | { status: 'divergent'; imageUrl: string; snapshotHash: string }
  | { status: 'convergent'; imageUrl: string }
  | { status: 'frame-deleted' };

/**
 * Pulled out of the workflow body so the call sequence is testable without
 * bootstrapping `createWorkflow`. The workflow remains responsible for the
 * `context.run` boundary and for resolving `currentHash` via
 * `context.snapshot.computeCurrent()` so retries re-resolve live state
 * cheaply without re-running this orchestration on a successful step.
 *
 * Idempotent on retry: `frames.update` and
 * `frameVariants.updateByFrameAndModel` are last-write-wins, and
 * `frameVariants.insertDivergent` pre-checks `(frame, type, model, hash)`.
 */
export async function persistImageResult(opts: {
  scopedDb: PersistImageScopedDb;
  frameId: string;
  sequenceId: string;
  model: string;
  upload: ImageStorageResult;
  snapshotHash: string | null;
  currentHash: string | null;
  promptHash: string | null;
  emit: (
    event: 'generation.image:progress',
    payload: {
      frameId: string;
      status: 'pending' | 'completed';
      model: string;
      thumbnailUrl?: string;
    }
  ) => Promise<void>;
  now?: () => Date;
}): Promise<PersistImageOutcome> {
  const {
    scopedDb,
    frameId,
    sequenceId,
    model,
    upload,
    snapshotHash,
    currentHash,
    promptHash,
    emit,
    now = () => new Date(),
  } = opts;

  if (snapshotHash && currentHash !== snapshotHash) {
    const writes = buildImageDivergentWrites({
      upload,
      snapshotHash,
      promptHash,
      divergedAt: now(),
    });

    const updatedFrame = await scopedDb.frames.update(frameId, writes.frame, {
      throwOnMissing: false,
    });
    if (!updatedFrame) return { status: 'frame-deleted' };

    await scopedDb.frameVariants.updateByFrameAndModel(
      frameId,
      'image',
      model,
      writes.primaryRevert
    );

    await scopedDb.frameVariants.insertDivergent({
      frameId,
      sequenceId,
      variantType: 'image',
      model,
      ...writes.divergentRow,
    });

    await emit('generation.image:progress', {
      frameId,
      status: 'pending',
      model,
    });

    return { status: 'divergent', imageUrl: upload.url, snapshotHash };
  }

  const writes = buildImageConvergentWrites({
    upload,
    snapshotHash,
    promptHash,
    generatedAt: now(),
  });

  const updatedFrame = await scopedDb.frames.update(frameId, writes.frame, {
    throwOnMissing: false,
  });
  if (!updatedFrame) return { status: 'frame-deleted' };

  await scopedDb.frameVariants.updateByFrameAndModel(
    frameId,
    'image',
    model,
    writes.variant
  );

  await emit('generation.image:progress', {
    frameId,
    status: 'completed',
    thumbnailUrl: upload.url,
    model,
  });

  return { status: 'convergent', imageUrl: upload.url };
}
