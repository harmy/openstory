/**
 * Behavioural tests for the per-frame image-workflow snapshot helpers.
 *
 * `generateImageWorkflow` opts into the snapshot pattern so it can detect
 * drift between trigger-time and write-time and route divergent results into
 * `frame_variants`. These tests pin the two contract paths the workflow
 * branches on:
 *
 *   - convergent: live state matches the inlined snapshot → primary write
 *   - divergent: a character sheet was re-hashed mid-flight → alternate write
 */

import { describe, expect, it } from 'bun:test';
import type { NewFrame, NewFrameVariant } from '@/lib/db/schema';
import type { VariantType } from '@/lib/db/schema/frame-variants';
import type {
  FrameImageSceneSnapshot,
  ImageWorkflowInput,
} from '@/lib/workflow/types';
import {
  buildImageConvergentWrites,
  buildImageDivergentWrites,
  computeImageWorkflowHashCurrent,
  computeImageWorkflowHashFromDto,
  type ImageHashScopedDb,
  type PersistImageScopedDb,
  persistImageResult,
  type SceneForHash,
} from './image-workflow-snapshot';

const baseScene: FrameImageSceneSnapshot = {
  sceneId: 's1',
  visualPrompt: 'A wide establishing shot of Jack at the docks at dusk',
  characterSheetHashes: ['jack-hash-v1'],
  locationSheetHashes: ['docks-hash-v1'],
  elementReferenceHashes: [],
};

const baseInput: ImageWorkflowInput = {
  userId: 'u1',
  teamId: 't1',
  sequenceId: 'seq1',
  frameId: 'f1',
  prompt: baseScene.visualPrompt,
  model: 'nano_banana_2',
  aspectRatio: '16:9',
  sceneSnapshot: baseScene,
};

const DEFAULT_SCENE: SceneForHash = {
  continuity: {
    characterTags: ['jack'],
    environmentTag: 'docks',
    elementTags: [],
  },
  metadata: { location: 'Docks' },
  originalScript: { extract: '' },
};

function buildHashScopedDb(opts: {
  characterSheetHash?: string | null;
  locationReferenceHash?: string | null;
  elementImageUrl?: string;
  frameMetadata?: SceneForHash | null;
}): ImageHashScopedDb {
  // `in` check distinguishes explicit `null` (data-corruption case) from omitted (default).
  const metadata =
    'frameMetadata' in opts ? (opts.frameMetadata ?? null) : DEFAULT_SCENE;
  return {
    frames: {
      getById: async () => ({ metadata }),
    },
    characters: {
      listWithSheets: async () =>
        opts.characterSheetHash === undefined
          ? []
          : [
              {
                id: 'c1',
                characterId: 'jack',
                consistencyTag: 'jack',
                name: 'Jack',
                physicalDescription: null,
                sheetImageUrl: 'https://example.com/jack.png',
                sheetStatus: 'completed',
                sheetInputHash: opts.characterSheetHash,
              },
            ],
    },
    sequenceLocations: {
      listWithReferences: async () =>
        opts.locationReferenceHash === undefined
          ? []
          : [
              {
                id: 'l1',
                locationId: 'docks',
                description: null,
                consistencyTag: 'docks',
                name: 'Docks',
                referenceImageUrl: 'https://example.com/docks.png',
                referenceStatus: 'completed',
                referenceInputHash: opts.locationReferenceHash,
              },
            ],
    },
    sequenceElements: {
      list: async () =>
        opts.elementImageUrl === undefined
          ? []
          : [
              {
                id: 'e1',
                token: 'LOGO',
                description: null,
                consistencyTag: 'logo',
                imageUrl: opts.elementImageUrl,
              },
            ],
    },
  };
}

const unreachableHashScopedDb: ImageHashScopedDb = {
  frames: {
    getById: async () => {
      throw new Error('frames.getById should not be called in this test');
    },
  },
  characters: {
    listWithSheets: async () => {
      throw new Error('characters.listWithSheets should not be called');
    },
  },
  sequenceLocations: {
    listWithReferences: async () => {
      throw new Error(
        'sequenceLocations.listWithReferences should not be called'
      );
    },
  },
  sequenceElements: {
    list: async () => {
      throw new Error('sequenceElements.list should not be called');
    },
  },
};

describe('computeImageWorkflowHashFromDto', () => {
  it('returns the inlined hash sentinel when no snapshot is opted in', async () => {
    const result = await computeImageWorkflowHashFromDto({
      ...baseInput,
      sceneSnapshot: undefined,
      snapshotInputHash: undefined,
    });
    expect(result).toBe('');
  });

  it('produces a deterministic hash for identical snapshots', async () => {
    const a = await computeImageWorkflowHashFromDto(baseInput);
    const b = await computeImageWorkflowHashFromDto(baseInput);
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('changes the hash when the model changes', async () => {
    const a = await computeImageWorkflowHashFromDto(baseInput);
    const b = await computeImageWorkflowHashFromDto({
      ...baseInput,
      model: 'seedream_v5',
    });
    expect(a).not.toBe(b);
  });

  it('changes the hash when a character sheet hash changes', async () => {
    const a = await computeImageWorkflowHashFromDto(baseInput);
    const b = await computeImageWorkflowHashFromDto({
      ...baseInput,
      sceneSnapshot: {
        ...baseScene,
        characterSheetHashes: ['jack-hash-v2'],
      },
    });
    expect(a).not.toBe(b);
  });
});

describe('computeImageWorkflowHashCurrent', () => {
  it('matches the DTO hash on the convergent path (live state == snapshot)', async () => {
    const dtoHash = await computeImageWorkflowHashFromDto(baseInput);
    const currentHash = await computeImageWorkflowHashCurrent(
      baseInput,
      buildHashScopedDb({
        characterSheetHash: 'jack-hash-v1',
        locationReferenceHash: 'docks-hash-v1',
      })
    );
    expect(currentHash).toBe(dtoHash);
  });

  it('diverges from the DTO hash when a character sheet was re-hashed mid-flight', async () => {
    const dtoHash = await computeImageWorkflowHashFromDto(baseInput);
    const currentHash = await computeImageWorkflowHashCurrent(
      baseInput,
      buildHashScopedDb({
        characterSheetHash: 'jack-hash-v2',
        locationReferenceHash: 'docks-hash-v1',
      })
    );
    expect(currentHash).not.toBe(dtoHash);
  });

  it('diverges when an element reference image was swapped', async () => {
    const inputWithElement: ImageWorkflowInput = {
      ...baseInput,
      sceneSnapshot: {
        ...baseScene,
        elementReferenceHashes: ['https://example.com/logo-v1.png'],
      },
    };
    const stub = buildHashScopedDb({
      characterSheetHash: 'jack-hash-v1',
      locationReferenceHash: 'docks-hash-v1',
      elementImageUrl: 'https://example.com/logo-v2.png',
      frameMetadata: {
        continuity: {
          characterTags: ['jack'],
          environmentTag: 'docks',
          elementTags: ['LOGO'],
        },
        metadata: { location: 'Docks' },
        originalScript: { extract: 'see LOGO at the door' },
      },
    });
    const dtoHash = await computeImageWorkflowHashFromDto(inputWithElement);
    const currentHash = await computeImageWorkflowHashCurrent(
      inputWithElement,
      stub
    );
    expect(currentHash).not.toBe(dtoHash);
  });

  it('returns the inlined hash sentinel when no snapshot is opted in', async () => {
    const result = await computeImageWorkflowHashCurrent(
      { ...baseInput, sceneSnapshot: undefined, snapshotInputHash: undefined },
      unreachableHashScopedDb
    );
    expect(result).toBe('');
  });

  it('throws when sceneSnapshot is present but aspectRatio is missing', () => {
    expect(
      computeImageWorkflowHashCurrent(
        { ...baseInput, aspectRatio: undefined },
        buildHashScopedDb({
          characterSheetHash: 'jack-hash-v1',
          locationReferenceHash: 'docks-hash-v1',
        })
      )
    ).rejects.toThrow(/aspectRatio is required/);
  });

  it('throws when the frame exists but has null metadata (data corruption)', () => {
    const stub = buildHashScopedDb({
      characterSheetHash: 'jack-hash-v1',
      locationReferenceHash: 'docks-hash-v1',
      frameMetadata: null,
    });
    expect(computeImageWorkflowHashCurrent(baseInput, stub)).rejects.toThrow(
      /null metadata/
    );
  });
});

describe('computeImageWorkflowHashFromDto — aspectRatio guard', () => {
  it('throws when sceneSnapshot is present but aspectRatio is missing', () => {
    expect(() =>
      computeImageWorkflowHashFromDto({
        ...baseInput,
        aspectRatio: undefined,
      })
    ).toThrow(/aspectRatio is required/);
  });
});

describe('buildImageConvergentWrites', () => {
  const upload = {
    url: 'https://r2/jack-final.png',
    path: 'team/seq/jack.png',
  };
  const generatedAt = new Date('2026-05-04T00:00:00Z');

  it('stamps the new thumbnail + records snapshot hash + clears stale preview/video', () => {
    const writes = buildImageConvergentWrites({
      upload,
      snapshotHash: 'hash-abc',
      promptHash: 'prompt-xyz',
      generatedAt,
    });

    expect(writes.frame).toEqual({
      thumbnailPath: upload.path,
      thumbnailUrl: upload.url,
      thumbnailStatus: 'completed',
      thumbnailGeneratedAt: generatedAt,
      thumbnailError: null,
      thumbnailInputHash: 'hash-abc',
      videoUrl: null,
      videoPath: null,
      videoStatus: 'pending',
      videoWorkflowRunId: null,
      videoGeneratedAt: null,
      videoError: null,
    });

    expect(writes.variant).toEqual({
      url: upload.url,
      storagePath: upload.path,
      previewUrl: null,
      status: 'completed',
      generatedAt,
      error: null,
      promptHash: 'prompt-xyz',
      inputHash: 'hash-abc',
    });
  });

  it('writes a null inputHash when the workflow did not opt into snapshots', () => {
    const writes = buildImageConvergentWrites({
      upload,
      snapshotHash: null,
      promptHash: null,
      generatedAt,
    });
    expect(writes.frame.thumbnailInputHash).toBeNull();
    expect(writes.variant.inputHash).toBeNull();
  });
});

describe('buildImageDivergentWrites', () => {
  const upload = { url: 'https://r2/jack-alt.png', path: 'team/seq/alt.png' };
  const divergedAt = new Date('2026-05-04T00:00:00Z');

  it('reverts the speculative primary (incl. thumbnailUrl/Path) and emits an alternate row', () => {
    const writes = buildImageDivergentWrites({
      upload,
      snapshotHash: 'hash-xyz',
      promptHash: 'prompt-pqr',
      divergedAt,
    });

    // Critically: thumbnailUrl AND thumbnailPath are both nulled so an
    // already-completed frame doesn't carry a stale URL into pending state.
    expect(writes.frame).toEqual({
      thumbnailUrl: null,
      thumbnailPath: null,
      thumbnailStatus: 'pending',
      thumbnailWorkflowRunId: null,
      thumbnailGeneratedAt: null,
      thumbnailError: null,
      thumbnailInputHash: null,
    });

    expect(writes.primaryRevert).toEqual({
      url: null,
      storagePath: null,
      previewUrl: null,
      status: 'pending',
      workflowRunId: null,
      generatedAt: null,
      error: null,
      inputHash: null,
    });

    // inputHash + divergedAt key the divergent partial unique index for
    // insertDivergent idempotency on QStash retry.
    expect(writes.divergentRow).toEqual({
      url: upload.url,
      storagePath: upload.path,
      status: 'completed',
      generatedAt: divergedAt,
      error: null,
      promptHash: 'prompt-pqr',
      inputHash: 'hash-xyz',
      divergedAt,
    });
  });
});

describe('persistImageResult — orchestration', () => {
  const upload = { url: 'https://r2/jack.png', path: 'team/seq/jack.png' };
  const NOW = new Date('2026-05-04T00:00:00Z');

  type FrameUpdateCall = {
    frameId: string;
    data: Partial<NewFrame>;
  };
  type VariantUpdateCall = {
    frameId: string;
    variantType: VariantType;
    model: string;
    data: Partial<NewFrameVariant>;
  };
  type InsertDivergentCall = NewFrameVariant & {
    inputHash: string;
    divergedAt: Date;
  };
  type CallOrder =
    | 'frames.update'
    | 'frameVariants.updateByFrameAndModel'
    | 'frameVariants.insertDivergent';

  function buildScopedDbSpy(opts: { frameMissing?: boolean } = {}): {
    scopedDb: PersistImageScopedDb;
    framesUpdates: FrameUpdateCall[];
    variantsUpdates: VariantUpdateCall[];
    variantsInserts: InsertDivergentCall[];
    callOrder: CallOrder[];
  } {
    const framesUpdates: FrameUpdateCall[] = [];
    const variantsUpdates: VariantUpdateCall[] = [];
    const variantsInserts: InsertDivergentCall[] = [];
    const callOrder: CallOrder[] = [];
    const scopedDb: PersistImageScopedDb = {
      frames: {
        update: async (frameId, data) => {
          framesUpdates.push({ frameId, data });
          callOrder.push('frames.update');
          if (opts.frameMissing) return undefined;
          return { id: frameId };
        },
      },
      frameVariants: {
        updateByFrameAndModel: async (frameId, variantType, model, data) => {
          variantsUpdates.push({ frameId, variantType, model, data });
          callOrder.push('frameVariants.updateByFrameAndModel');
          return { id: 'v1' };
        },
        insertDivergent: async (data) => {
          variantsInserts.push(data);
          callOrder.push('frameVariants.insertDivergent');
          return { id: 'v2' };
        },
      },
    };
    return {
      scopedDb,
      framesUpdates,
      variantsUpdates,
      variantsInserts,
      callOrder,
    };
  }

  it('divergent path: reverts primary frames row, reverts primary variant, inserts divergent alternate, emits pending', async () => {
    const {
      scopedDb,
      framesUpdates,
      variantsUpdates,
      variantsInserts,
      callOrder,
    } = buildScopedDbSpy();
    const emits: Array<{ event: string; payload: unknown }> = [];

    const outcome = await persistImageResult({
      scopedDb,
      frameId: 'f1',
      sequenceId: 'seq1',
      model: 'nano_banana_2',
      upload,
      snapshotHash: 'snapshot-abc',
      currentHash: 'current-xyz',
      promptHash: 'prompt-1',
      emit: async (event, payload) => {
        emits.push({ event, payload });
      },
      now: () => NOW,
    });

    expect(outcome).toEqual({
      status: 'divergent',
      imageUrl: upload.url,
      snapshotHash: 'snapshot-abc',
    });

    expect(callOrder).toEqual([
      'frames.update',
      'frameVariants.updateByFrameAndModel',
      'frameVariants.insertDivergent',
    ]);

    const frameUpdate = framesUpdates[0].data;
    expect(frameUpdate.thumbnailUrl).toBeNull();
    expect(frameUpdate.thumbnailPath).toBeNull();
    expect(frameUpdate.thumbnailStatus).toBe('pending');
    expect(frameUpdate.thumbnailInputHash).toBeNull();

    const variantRevert = variantsUpdates[0].data;
    expect(variantRevert.url).toBeNull();
    expect(variantRevert.previewUrl).toBeNull();
    expect(variantRevert.status).toBe('pending');
    expect(variantRevert.inputHash).toBeNull();

    const divergentRow = variantsInserts[0];
    expect(divergentRow.frameId).toBe('f1');
    expect(divergentRow.sequenceId).toBe('seq1');
    expect(divergentRow.variantType).toBe('image');
    expect(divergentRow.model).toBe('nano_banana_2');
    expect(divergentRow.url).toBe(upload.url);
    expect(divergentRow.inputHash).toBe('snapshot-abc');
    expect(divergentRow.divergedAt).toBe(NOW);
    expect(divergentRow.status).toBe('completed');

    expect(emits).toEqual([
      {
        event: 'generation.image:progress',
        payload: { frameId: 'f1', status: 'pending', model: 'nano_banana_2' },
      },
    ]);
  });

  it('convergent path: stamps primary frames row + primary variant with snapshot hash, emits completed, NO insertDivergent call', async () => {
    const {
      scopedDb,
      framesUpdates,
      variantsUpdates,
      variantsInserts,
      callOrder,
    } = buildScopedDbSpy();
    const emits: Array<{ event: string; payload: unknown }> = [];

    const outcome = await persistImageResult({
      scopedDb,
      frameId: 'f1',
      sequenceId: 'seq1',
      model: 'nano_banana_2',
      upload,
      snapshotHash: 'snapshot-abc',
      currentHash: 'snapshot-abc',
      promptHash: 'prompt-1',
      emit: async (event, payload) => {
        emits.push({ event, payload });
      },
      now: () => NOW,
    });

    expect(outcome).toEqual({ status: 'convergent', imageUrl: upload.url });

    expect(callOrder).toEqual([
      'frames.update',
      'frameVariants.updateByFrameAndModel',
    ]);

    const frameUpdate = framesUpdates[0].data;
    expect(frameUpdate.thumbnailUrl).toBe(upload.url);
    expect(frameUpdate.thumbnailStatus).toBe('completed');
    expect(frameUpdate.thumbnailInputHash).toBe('snapshot-abc');

    const variantWrite = variantsUpdates[0].data;
    expect(variantWrite.url).toBe(upload.url);
    expect(variantWrite.status).toBe('completed');
    expect(variantWrite.inputHash).toBe('snapshot-abc');
    expect(variantWrite.previewUrl).toBeNull();

    expect(variantsInserts).toEqual([]);

    expect(emits).toEqual([
      {
        event: 'generation.image:progress',
        payload: {
          frameId: 'f1',
          status: 'completed',
          thumbnailUrl: upload.url,
          model: 'nano_banana_2',
        },
      },
    ]);
  });

  it('non-snapshot mode (snapshotHash null): convergent write with null inputHash, NO insertDivergent', async () => {
    const { scopedDb, framesUpdates, variantsUpdates, variantsInserts } =
      buildScopedDbSpy();
    const emits: Array<{ event: string; payload: unknown }> = [];

    const outcome = await persistImageResult({
      scopedDb,
      frameId: 'f1',
      sequenceId: 'seq1',
      model: 'nano_banana_2',
      upload,
      snapshotHash: null,
      currentHash: null,
      promptHash: null,
      emit: async (event, payload) => {
        emits.push({ event, payload });
      },
      now: () => NOW,
    });

    expect(outcome.status).toBe('convergent');
    expect(framesUpdates[0].data.thumbnailInputHash).toBeNull();
    expect(variantsUpdates[0].data.inputHash).toBeNull();
    expect(variantsInserts).toEqual([]);
  });

  it('frame deleted mid-flight: short-circuits without touching frame_variants', async () => {
    const { scopedDb, framesUpdates, variantsUpdates, variantsInserts } =
      buildScopedDbSpy({ frameMissing: true });

    const outcome = await persistImageResult({
      scopedDb,
      frameId: 'f1',
      sequenceId: 'seq1',
      model: 'nano_banana_2',
      upload,
      snapshotHash: 'snapshot-abc',
      currentHash: 'current-xyz',
      promptHash: null,
      emit: async () => {},
      now: () => NOW,
    });

    expect(outcome).toEqual({ status: 'frame-deleted' });
    expect(framesUpdates.length).toBe(1);
    expect(variantsUpdates).toEqual([]);
    expect(variantsInserts).toEqual([]);
  });
});
