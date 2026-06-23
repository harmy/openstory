/**
 * Snapshot DTO hashers + persist orchestration for `generateImageWorkflow`.
 *
 * `computeFromDto` hashes the inlined per-scene snapshot for the start-time
 * tamper check. `computeCurrent` re-resolves the live character / location /
 * element sheet hashes from the scoped DB so the workflow can detect upstream
 * drift between trigger and write time and route divergent results into
 * `shot_variants` instead of overwriting the primary thumbnail.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § "Pillar 3: Divergence-on-completion".
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type {
  CharacterMinimal,
  NewShot,
  NewShotVariant,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/lib/db/schema';
import type { VariantType } from '@/lib/db/schema/shot-variants';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  ShotImageSceneSnapshot,
  ImageWorkflowInput,
} from '@/lib/workflow/types';
import { buildDivergentRevertWrites } from './divergence-writes';
import {
  computeShotImageSceneHash,
  resolveSceneShotImageReferences,
} from './sheet-snapshots';

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
    // nullable: `Scene.continuity.elementTags` is `.nullish()` (model emits
    // null when no elements) — keep this assignable from production `Scene`.
    elementTags?: string[] | null;
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
  shots: {
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
  shots: {
    update: (
      id: string,
      data: Partial<NewShot>,
      opts?: { throwOnMissing?: boolean }
    ) => Promise<{ id: string } | undefined>;
  };
  shotVariants: {
    updateByShotAndModel: (
      shotId: string,
      type: VariantType,
      model: string,
      data: Partial<NewShotVariant>
    ) => Promise<{ id: string } | null>;
    insertDivergent: (
      data: NewShotVariant & { inputHash: string; divergedAt: Date }
    ) => Promise<{ id: string }>;
  };
};

const NO_SNAPSHOT_SENTINEL = '';

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
  return computeShotImageSceneHash(
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

  if (!input.sequenceId || !input.shotId) {
    return computeShotImageSceneHash(input.sceneSnapshot, model, aspectRatio);
  }

  const shot = await scopedDb.shots.getById(input.shotId);
  // Deleted mid-flight: collapse to convergent so the workflow's
  // deleted-shot short-circuit handles the cleanup. Distinct from a shot
  // that exists with null metadata, which is data corruption — refuse.
  if (!shot) {
    return computeShotImageSceneHash(input.sceneSnapshot, model, aspectRatio);
  }
  if (!shot.metadata) {
    throw new WorkflowValidationError(
      `Shot ${input.shotId} exists but has null metadata; snapshot recompute requires scene metadata`
    );
  }

  const [characters, locations, elements] = await Promise.all([
    scopedDb.characters.listWithSheets(input.sequenceId),
    scopedDb.sequenceLocations.listWithReferences(input.sequenceId),
    scopedDb.sequenceElements.list(input.sequenceId),
  ]);

  const refs = resolveSceneShotImageReferences({
    scene: shot.metadata,
    characters,
    locations,
    elements,
  });

  const currentSnapshot: ShotImageSceneSnapshot = {
    sceneId: input.sceneSnapshot.sceneId,
    visualPrompt: input.sceneSnapshot.visualPrompt,
    characterSheetHashes: refs.characterSheetHashes,
    locationSheetHashes: refs.locationSheetHashes,
    elementReferenceHashes: refs.elementReferenceHashes,
  };

  return computeShotImageSceneHash(currentSnapshot, model, aspectRatio);
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
  shot: Partial<NewShot>;
  variant: Partial<NewShotVariant>;
} {
  const { upload, snapshotHash, promptHash, generatedAt } = opts;
  return {
    shot: {
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
 * caller supplies shotId/sequenceId/variantType/model; this helper supplies
 * the content fields including the `inputHash` + `divergedAt` keys that match
 * the `shot_variants` divergent partial unique index.
 */
export function buildImageDivergentWrites(opts: {
  upload: ImageStorageResult;
  snapshotHash: string;
  promptHash: string | null;
  divergedAt: Date;
}): {
  shot: Partial<NewShot>;
  primaryRevert: Partial<NewShotVariant>;
  divergentRow: Partial<NewShotVariant> & {
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
  | { status: 'variant-only'; imageUrl: string }
  | { status: 'shot-deleted' };

/**
 * Pulled out of the workflow body so the call sequence is testable without
 * bootstrapping `createWorkflow`. The workflow remains responsible for the
 * `context.run` boundary and for resolving `currentHash` via
 * `context.snapshot.computeCurrent()` so retries re-resolve live state
 * cheaply without re-running this orchestration on a successful step.
 *
 * Idempotent on retry: `shots.update` and
 * `shotVariants.updateByShotAndModel` are last-write-wins, and
 * `shotVariants.insertDivergent` pre-checks `(shot, type, model, hash)`.
 */
export async function persistImageResult(opts: {
  scopedDb: PersistImageScopedDb;
  shotId: string;
  sequenceId: string;
  model: string;
  upload: ImageStorageResult;
  snapshotHash: string | null;
  currentHash: string | null;
  promptHash: string | null;
  emit: (
    event: 'generation.image:progress',
    payload: {
      shotId: string;
      status: 'pending' | 'completed';
      model: string;
      thumbnailUrl?: string;
      variantOnly?: boolean;
    }
  ) => Promise<void>;
  /**
   * Variant-only (#547): write only this model's `shot_variants` row, never
   * the primary `shots.*`. Skips divergence detection — with no primary to
   * protect, there is nothing to diverge from.
   */
  variantOnly?: boolean;
  now?: () => Date;
}): Promise<PersistImageOutcome> {
  const {
    scopedDb,
    shotId,
    sequenceId,
    model,
    upload,
    snapshotHash,
    currentHash,
    promptHash,
    emit,
    variantOnly,
    now = () => new Date(),
  } = opts;

  if (variantOnly) {
    // Reuse the convergent variant payload (url/path/status/hashes), but apply
    // it ONLY to the variant row — the primary `shots.*` stay exactly as they
    // were. A null update means the shot (and its cascade-deleted variant) is
    // gone.
    const { variant } = buildImageConvergentWrites({
      upload,
      snapshotHash,
      promptHash,
      generatedAt: now(),
    });
    const updated = await scopedDb.shotVariants.updateByShotAndModel(
      shotId,
      'image',
      model,
      variant
    );
    if (!updated) return { status: 'shot-deleted' };

    await emit('generation.image:progress', {
      shotId,
      status: 'completed',
      thumbnailUrl: upload.url,
      model,
      // Alternate model — the cache updater must not repoint the primary.
      variantOnly: true,
    });

    return { status: 'variant-only', imageUrl: upload.url };
  }

  if (snapshotHash && currentHash !== snapshotHash) {
    const writes = buildImageDivergentWrites({
      upload,
      snapshotHash,
      promptHash,
      divergedAt: now(),
    });

    const updatedShot = await scopedDb.shots.update(shotId, writes.shot, {
      throwOnMissing: false,
    });
    if (!updatedShot) return { status: 'shot-deleted' };

    await scopedDb.shotVariants.updateByShotAndModel(
      shotId,
      'image',
      model,
      writes.primaryRevert
    );

    await scopedDb.shotVariants.insertDivergent({
      shotId,
      sequenceId,
      variantType: 'image',
      model,
      ...writes.divergentRow,
    });

    await emit('generation.image:progress', {
      shotId,
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

  const updatedShot = await scopedDb.shots.update(shotId, writes.shot, {
    throwOnMissing: false,
  });
  if (!updatedShot) return { status: 'shot-deleted' };

  await scopedDb.shotVariants.updateByShotAndModel(
    shotId,
    'image',
    model,
    writes.variant
  );

  await emit('generation.image:progress', {
    shotId,
    status: 'completed',
    thumbnailUrl: upload.url,
    model,
  });

  return { status: 'convergent', imageUrl: upload.url };
}
