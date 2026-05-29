/**
 * Behavioural tests for the regenerate-frames snapshot helpers.
 *
 * These cover the two critical paths the workflow branches on:
 *   - convergent: trigger-time and write-time hashes match → primary write
 *   - divergent: a character is recast mid-flight → write to frame_variants
 *
 * The workflow itself orchestrates those writes; we verify here that the
 * helpers correctly detect divergence so the downstream branching is sound.
 */

import { describe, expect, it } from 'vitest';
import type { Character, Frame, SequenceLocation } from '@/lib/db/schema';
import { validateSnapshotPayload } from '@/lib/workflow/scoped-workflow';
import {
  buildConvergentWrites,
  buildDivergentWrites,
  buildRegenerateFrameSnapshot,
  computeRegenerateFramesBatchHash,
} from './regenerate-frames-snapshot';

const NOW = new Date('2026-04-29T00:00:00Z');

function makeCharacter(overrides: Partial<Character> = {}): Character {
  const character: Character = {
    id: 'c1',
    sequenceId: 'seq1',
    characterId: 'jack',
    name: 'Jack',
    age: '30s',
    gender: null,
    ethnicity: null,
    physicalDescription: null,
    standardClothing: null,
    distinguishingFeatures: null,
    consistencyTag: 'jack-the-pi',
    sheetImageUrl: 'https://example.com/jack.png',
    sheetImagePath: null,
    sheetStatus: 'completed',
    sheetGeneratedAt: NOW,
    sheetError: null,
    sheetInputHash: 'jack-hash-v1',
    talentId: null,
    firstMentionLine: null,
    firstMentionText: null,
    firstMentionSceneId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...character, ...overrides };
}

function makeFrame(overrides: Partial<Frame> = {}): Frame {
  const frame: Frame = {
    id: 'f1',
    sequenceId: 'seq1',
    orderIndex: 0,
    description: null,
    durationMs: 3000,
    thumbnailUrl: null,
    previewThumbnailUrl: null,
    thumbnailPath: null,
    variantImageUrl: null,
    variantImageStatus: 'pending',
    variantWorkflowRunId: null,
    variantImageGeneratedAt: null,
    variantImageError: null,
    videoUrl: null,
    videoPath: null,
    thumbnailStatus: 'pending',
    thumbnailWorkflowRunId: null,
    thumbnailGeneratedAt: null,
    thumbnailError: null,
    imageModel: 'nano_banana_2',
    imagePrompt: 'A scene with Jack at the docks',
    videoStatus: 'pending',
    videoWorkflowRunId: null,
    videoGeneratedAt: null,
    videoError: null,
    motionPrompt: null,
    motionModel: null,
    audioUrl: null,
    audioPath: null,
    audioStatus: 'pending',
    audioWorkflowRunId: null,
    audioGeneratedAt: null,
    audioError: null,
    audioModel: null,
    thumbnailInputHash: null,
    variantImageInputHash: null,
    videoInputHash: null,
    audioInputHash: null,
    visualPromptInputHash: null,
    motionPromptInputHash: null,
    metadata: {
      sceneId: 's1',
      sceneNumber: 1,
      originalScript: { extract: '', dialogue: [] },
      continuity: {
        characterTags: ['jack-the-pi'],
        environmentTag: '',
        colorPalette: '',
        lightingSetup: '',
        styleTag: '',
      },
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...frame, ...overrides };
}

const NO_LOCATIONS: SequenceLocation[] = [];

describe('buildRegenerateFrameSnapshot', () => {
  it('produces a deterministic snapshotInputHash for identical inputs', async () => {
    const frame = makeFrame();
    const characters = [makeCharacter()];

    const snapshotA = await buildRegenerateFrameSnapshot({
      frame,
      characters,
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    const snapshotB = await buildRegenerateFrameSnapshot({
      frame,
      characters,
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });

    expect(snapshotA.snapshotInputHash).toBe(snapshotB.snapshotInputHash);
    expect(snapshotA.characterSheetHashes).toEqual(['jack-hash-v1']);
  });

  it('changes the snapshotInputHash when a referenced character sheet hash changes', async () => {
    const frame = makeFrame();
    const before = await buildRegenerateFrameSnapshot({
      frame,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v1' })],
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    const after = await buildRegenerateFrameSnapshot({
      frame,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v2' })],
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });

    expect(after.snapshotInputHash).not.toBe(before.snapshotInputHash);
  });

  it('changes the snapshotInputHash when the imagePrompt changes', async () => {
    const characters = [makeCharacter()];
    const before = await buildRegenerateFrameSnapshot({
      frame: makeFrame({ imagePrompt: 'Original prompt' }),
      characters,
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    const after = await buildRegenerateFrameSnapshot({
      frame: makeFrame({ imagePrompt: 'Edited prompt' }),
      characters,
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(after.snapshotInputHash).not.toBe(before.snapshotInputHash);
  });

  it('skips characters whose sheet input_hash is null (legacy rows)', async () => {
    const frame = makeFrame();
    const snapshot = await buildRegenerateFrameSnapshot({
      frame,
      characters: [makeCharacter({ sheetInputHash: null })],
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(snapshot.characterSheetHashes).toEqual([]);
  });

  it('falls back to metadata.prompts.visual.fullPrompt when imagePrompt is null', async () => {
    const baseMetadata = makeFrame().metadata;
    if (!baseMetadata) throw new Error('test setup: base metadata missing');
    const frame = makeFrame({
      imagePrompt: null,
      metadata: {
        ...baseMetadata,
        prompts: {
          visual: {
            fullPrompt: 'AI-generated prompt from metadata',
            negativePrompt: '',
            components: {
              sceneDescription: '',
              subject: '',
              environment: '',
              lighting: '',
              camera: '',
              composition: '',
              style: '',
              technical: '',
              atmosphere: '',
            },
          },
        },
      },
    });
    const snapshot = await buildRegenerateFrameSnapshot({
      frame,
      characters: [makeCharacter()],
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(snapshot.imagePrompt).toBe('AI-generated prompt from metadata');
  });

  it('detects a metadata-prompt change as a hash change (regen-prompt staleness)', async () => {
    const baseMetadata = makeFrame().metadata;
    if (!baseMetadata) throw new Error('test setup: base metadata missing');
    const buildWithMetaPrompt = (fullPrompt: string) =>
      buildRegenerateFrameSnapshot({
        frame: makeFrame({
          imagePrompt: null,
          metadata: {
            ...baseMetadata,
            prompts: {
              visual: {
                fullPrompt,
                negativePrompt: '',
                components: {
                  sceneDescription: '',
                  subject: '',
                  environment: '',
                  lighting: '',
                  camera: '',
                  composition: '',
                  style: '',
                  technical: '',
                  atmosphere: '',
                },
              },
            },
          },
        }),
        characters: [makeCharacter()],
        locations: NO_LOCATIONS,
        imageModel: 'nano_banana_2',
        aspectRatio: '16:9',
      });

    const before = await buildWithMetaPrompt('Original AI prompt');
    const after = await buildWithMetaPrompt('Regenerated AI prompt');
    expect(after.snapshotInputHash).not.toBe(before.snapshotInputHash);
  });

  it('throws when both imagePrompt and metadata.prompts are absent', () => {
    expect(
      buildRegenerateFrameSnapshot({
        frame: makeFrame({ imagePrompt: null }),
        characters: [makeCharacter()],
        locations: NO_LOCATIONS,
        imageModel: 'nano_banana_2',
        aspectRatio: '16:9',
      })
    ).rejects.toThrow(/has no visual prompt/);
  });

  it('throws when imagePrompt is empty string and no metadata prompt', () => {
    expect(
      buildRegenerateFrameSnapshot({
        frame: makeFrame({ imagePrompt: '' }),
        characters: [makeCharacter()],
        locations: NO_LOCATIONS,
        imageModel: 'nano_banana_2',
        aspectRatio: '16:9',
      })
    ).rejects.toThrow(/has no visual prompt/);
  });
});

describe('computeRegenerateFramesBatchHash', () => {
  it('matches when frames are identical (regardless of order)', async () => {
    const frame1 = makeFrame({ id: 'f1' });
    const frame2 = makeFrame({ id: 'f2', orderIndex: 1 });
    const characters = [makeCharacter()];
    const opts = {
      characters,
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2' as const,
      aspectRatio: '16:9' as const,
    };
    const s1 = await buildRegenerateFrameSnapshot({ frame: frame1, ...opts });
    const s2 = await buildRegenerateFrameSnapshot({ frame: frame2, ...opts });

    const hashAB = await computeRegenerateFramesBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      frameSnapshots: [s1, s2],
    });
    const hashBA = await computeRegenerateFramesBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      frameSnapshots: [s2, s1],
    });

    expect(hashAB).toBe(hashBA);
  });

  it('diverges when one frame snapshot diverges (character recast mid-flight)', async () => {
    const frame = makeFrame();
    const opts = {
      frame,
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2' as const,
      aspectRatio: '16:9' as const,
    };
    const triggerTimeSnapshot = await buildRegenerateFrameSnapshot({
      ...opts,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v1' })],
    });
    const writeTimeSnapshot = await buildRegenerateFrameSnapshot({
      ...opts,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v2' })],
    });

    expect(writeTimeSnapshot.snapshotInputHash).not.toBe(
      triggerTimeSnapshot.snapshotInputHash
    );

    // Convergent: same hash on both sides → primary write
    const convergent = await computeRegenerateFramesBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      frameSnapshots: [triggerTimeSnapshot],
    });
    const convergentRecompute = await computeRegenerateFramesBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      frameSnapshots: [triggerTimeSnapshot],
    });
    expect(convergentRecompute).toBe(convergent);

    // Divergent: trigger-time hash differs from write-time recompute → variant
    const divergent = await computeRegenerateFramesBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      frameSnapshots: [writeTimeSnapshot],
    });
    expect(divergent).not.toBe(convergent);
  });

  it('detects tampering with characterRefs even when snapshotInputHash matches', async () => {
    const frame = makeFrame();
    const original = await buildRegenerateFrameSnapshot({
      frame,
      characters: [makeCharacter()],
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    // A tampered payload: same per-frame hash, but characterRefs swapped
    // for adversarial URLs. The batch hash must reject this.
    const tampered = {
      ...original,
      characterRefs: [
        {
          referenceImageUrl: 'https://attacker.example/swap.png',
          description: 'tampered',
          role: 'character' as const,
        },
      ],
    };
    const honestHash = await computeRegenerateFramesBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      frameSnapshots: [original],
    });
    const tamperedHash = await computeRegenerateFramesBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      frameSnapshots: [tampered],
    });
    expect(tamperedHash).not.toBe(honestHash);
  });
});

describe('buildConvergentWrites', () => {
  it('records the snapshot hash on the frame and resets variant divergence', () => {
    const writes = buildConvergentWrites('hash-abc');
    expect(writes.frame).toEqual({ thumbnailInputHash: 'hash-abc' });
    expect(writes.variant).toEqual({
      inputHash: 'hash-abc',
      divergedAt: null,
    });
  });
});

describe('buildDivergentWrites', () => {
  it('reverts the speculative primary (frame + variant) and emits an alternate row payload', () => {
    const at = new Date('2026-04-30T00:00:00Z');
    const writes = buildDivergentWrites('hash-xyz', at);

    // Frame row: primary thumbnail fully cleared so the next reconciliation
    // regenerates from current inputs and the user's live edits keep
    // ownership.
    expect(writes.frame).toEqual({
      thumbnailUrl: null,
      thumbnailPath: null,
      thumbnailStatus: 'pending',
      thumbnailWorkflowRunId: null,
      thumbnailGeneratedAt: null,
      thumbnailError: null,
      thumbnailInputHash: null,
    });

    // Primary variant row: speculative URL/status cleared so the primary
    // slot stops pointing at the diverged work that image-workflow pre-wrote.
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

    // Alternate row: divergence-specific fields. The workflow supplies
    // frameId/sequenceId/variantType/model/url; the helper marks divergence.
    expect(writes.divergentRow).toEqual({
      inputHash: 'hash-xyz',
      divergedAt: at,
      status: 'completed',
    });
  });
});

describe('validateSnapshotPayload', () => {
  it('passes when the payload hash matches the recompute', async () => {
    await validateSnapshotPayload(
      { snapshotInputHash: 'matching-hash' },
      () => 'matching-hash'
    );
  });

  it('throws when the payload hash differs from the recompute (tamper)', () => {
    expect(
      validateSnapshotPayload(
        { snapshotInputHash: 'stale-hash' },
        () => 'fresh-hash'
      )
    ).rejects.toThrow(/snapshotInputHash does not match the inlined DTO/);
  });

  it('throws when snapshotInputHash is missing entirely', () => {
    expect(
      validateSnapshotPayload(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- intentionally constructing an invalid payload to verify the runtime guard
        { snapshotInputHash: undefined } as unknown as {
          snapshotInputHash: string;
        },
        () => 'fresh-hash'
      )
    ).rejects.toThrow(/snapshotInputHash is required/);
  });

  it('awaits an async computeFromDto', async () => {
    const asyncMatching = async () => 'async-hash';
    await validateSnapshotPayload(
      { snapshotInputHash: 'async-hash' },
      asyncMatching
    );
    expect(
      validateSnapshotPayload(
        { snapshotInputHash: 'wrong-hash' },
        asyncMatching
      )
    ).rejects.toThrow();
  });
});
