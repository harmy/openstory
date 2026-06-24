/**
 * Behavioural tests for the regenerate-shots snapshot helpers.
 *
 * These cover the two critical paths the workflow branches on:
 *   - convergent: trigger-time and write-time hashes match → primary write
 *   - divergent: a character is recast mid-flight → write to shot_variants
 *
 * The workflow itself orchestrates those writes; we verify here that the
 * helpers correctly detect divergence so the downstream branching is sound.
 */

import { describe, expect, it } from 'vitest';
import type {
  Character,
  Shot,
  SequenceElement,
  SequenceLocation,
} from '@/lib/db/schema';
import {
  buildConvergentWrites,
  buildDivergentWrites,
  buildRegenerateShotSnapshot,
  computeRegenerateShotsBatchHash,
} from './regenerate-shots-snapshot';

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

function makeShot(overrides: Partial<Shot> = {}): Shot {
  const shot: Shot = {
    id: 'f1',
    sequenceId: 'seq1',
    sceneId: null,
    shotNumber: null,
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
  return { ...shot, ...overrides };
}

const NO_LOCATIONS: SequenceLocation[] = [];
const NO_ELEMENTS: SequenceElement[] = [];

function makeElement(
  overrides: Partial<SequenceElement> = {}
): SequenceElement {
  const element: SequenceElement = {
    id: 'e1',
    sequenceId: 'seq1',
    uploadedFilename: 'bottle.png',
    token: 'BOTTLE',
    description: 'A silver bottle',
    consistencyTag: 'silver-bottle',
    imageUrl: 'https://example.com/bottle.png',
    imagePath: 'elements/seq1/bottle.png',
    visionStatus: 'completed',
    visionError: null,
    visionGeneratedAt: NOW,
    firstMentionSceneId: null,
    firstMentionText: null,
    firstMentionLine: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
  return { ...element, ...overrides };
}

describe('buildRegenerateShotSnapshot', () => {
  it('produces a deterministic snapshotInputHash for identical inputs', async () => {
    const shot = makeShot();
    const characters = [makeCharacter()];

    const snapshotA = await buildRegenerateShotSnapshot({
      shot,
      characters,
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    const snapshotB = await buildRegenerateShotSnapshot({
      shot,
      characters,
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });

    expect(snapshotA.snapshotInputHash).toBe(snapshotB.snapshotInputHash);
    expect(snapshotA.characterSheetHashes).toEqual(['jack-hash-v1']);
  });

  it('changes the snapshotInputHash when a referenced character sheet hash changes', async () => {
    const shot = makeShot();
    const before = await buildRegenerateShotSnapshot({
      shot,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v1' })],
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    const after = await buildRegenerateShotSnapshot({
      shot,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v2' })],
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });

    expect(after.snapshotInputHash).not.toBe(before.snapshotInputHash);
  });

  it('changes the snapshotInputHash when the imagePrompt changes', async () => {
    const characters = [makeCharacter()];
    const before = await buildRegenerateShotSnapshot({
      shot: makeShot({ imagePrompt: 'Original prompt' }),
      characters,
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    const after = await buildRegenerateShotSnapshot({
      shot: makeShot({ imagePrompt: 'Edited prompt' }),
      characters,
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(after.snapshotInputHash).not.toBe(before.snapshotInputHash);
  });

  it('skips characters whose sheet input_hash is null (legacy rows)', async () => {
    const shot = makeShot();
    const snapshot = await buildRegenerateShotSnapshot({
      shot,
      characters: [makeCharacter({ sheetInputHash: null })],
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(snapshot.characterSheetHashes).toEqual([]);
  });

  it('falls back to metadata.prompts.visual.fullPrompt when imagePrompt is null', async () => {
    const baseMetadata = makeShot().metadata;
    if (!baseMetadata) throw new Error('test setup: base metadata missing');
    const shot = makeShot({
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
    const snapshot = await buildRegenerateShotSnapshot({
      shot,
      characters: [makeCharacter()],
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(snapshot.imagePrompt).toBe('AI-generated prompt from metadata');
  });

  it('detects a metadata-prompt change as a hash change (regen-prompt staleness)', async () => {
    const baseMetadata = makeShot().metadata;
    if (!baseMetadata) throw new Error('test setup: base metadata missing');
    const buildWithMetaPrompt = (fullPrompt: string) =>
      buildRegenerateShotSnapshot({
        shot: makeShot({
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
        elements: NO_ELEMENTS,
        imageModel: 'nano_banana_2',
        aspectRatio: '16:9',
      });

    const before = await buildWithMetaPrompt('Original AI prompt');
    const after = await buildWithMetaPrompt('Regenerated AI prompt');
    expect(after.snapshotInputHash).not.toBe(before.snapshotInputHash);
  });

  it('throws when both imagePrompt and metadata.prompts are absent', () => {
    expect(
      buildRegenerateShotSnapshot({
        shot: makeShot({ imagePrompt: null }),
        characters: [makeCharacter()],
        locations: NO_LOCATIONS,
        elements: NO_ELEMENTS,
        imageModel: 'nano_banana_2',
        aspectRatio: '16:9',
      })
    ).rejects.toThrow(/has no visual prompt/);
  });

  it('throws when imagePrompt is empty string and no metadata prompt', () => {
    expect(
      buildRegenerateShotSnapshot({
        shot: makeShot({ imagePrompt: '' }),
        characters: [makeCharacter()],
        locations: NO_LOCATIONS,
        elements: NO_ELEMENTS,
        imageModel: 'nano_banana_2',
        aspectRatio: '16:9',
      })
    ).rejects.toThrow(/has no visual prompt/);
  });

  // #867 (image): a shot that references a product element must hash that
  // element's reference — verify previously hard-coded `[]`, so every
  // element-bearing shot reported permanently stale.
  const shotMentioning = (token: string): Shot => {
    const base = makeShot().metadata;
    if (!base) throw new Error('test setup: metadata missing');
    return makeShot({
      metadata: {
        ...base,
        originalScript: { extract: `The ${token} sits here.`, dialogue: [] },
      },
    });
  };

  it('includes a referenced element’s reference hash in the snapshot', async () => {
    const snapshot = await buildRegenerateShotSnapshot({
      shot: shotMentioning('BOTTLE'),
      characters: [makeCharacter()],
      locations: NO_LOCATIONS,
      elements: [makeElement()],
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(snapshot.elementReferenceHashes).toEqual([
      'https://example.com/bottle.png',
    ]);
  });

  it('changes the snapshotInputHash when a referenced element image changes', async () => {
    const opts = {
      shot: shotMentioning('BOTTLE'),
      characters: [makeCharacter()],
      locations: NO_LOCATIONS,
      imageModel: 'nano_banana_2' as const,
      aspectRatio: '16:9' as const,
    };
    const before = await buildRegenerateShotSnapshot({
      ...opts,
      elements: [
        makeElement({ imageUrl: 'https://example.com/bottle-v1.png' }),
      ],
    });
    const after = await buildRegenerateShotSnapshot({
      ...opts,
      elements: [
        makeElement({ imageUrl: 'https://example.com/bottle-v2.png' }),
      ],
    });
    expect(after.snapshotInputHash).not.toBe(before.snapshotInputHash);
  });

  it('ignores elements the shot does not reference', async () => {
    const snapshot = await buildRegenerateShotSnapshot({
      shot: makeShot(), // empty script + no elementTags → no element matches
      characters: [makeCharacter()],
      locations: NO_LOCATIONS,
      elements: [makeElement()],
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    expect(snapshot.elementReferenceHashes).toEqual([]);
  });
});

describe('computeRegenerateShotsBatchHash', () => {
  it('matches when shots are identical (regardless of order)', async () => {
    const shot1 = makeShot({ id: 'f1' });
    const shot2 = makeShot({ id: 'f2', orderIndex: 1 });
    const characters = [makeCharacter()];
    const opts = {
      characters,
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2' as const,
      aspectRatio: '16:9' as const,
    };
    const s1 = await buildRegenerateShotSnapshot({ shot: shot1, ...opts });
    const s2 = await buildRegenerateShotSnapshot({ shot: shot2, ...opts });

    const hashAB = await computeRegenerateShotsBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      shotSnapshots: [s1, s2],
    });
    const hashBA = await computeRegenerateShotsBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      shotSnapshots: [s2, s1],
    });

    expect(hashAB).toBe(hashBA);
  });

  it('diverges when one shot snapshot diverges (character recast mid-flight)', async () => {
    const shot = makeShot();
    const opts = {
      shot,
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2' as const,
      aspectRatio: '16:9' as const,
    };
    const triggerTimeSnapshot = await buildRegenerateShotSnapshot({
      ...opts,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v1' })],
    });
    const writeTimeSnapshot = await buildRegenerateShotSnapshot({
      ...opts,
      characters: [makeCharacter({ sheetInputHash: 'jack-hash-v2' })],
    });

    expect(writeTimeSnapshot.snapshotInputHash).not.toBe(
      triggerTimeSnapshot.snapshotInputHash
    );

    // Convergent: same hash on both sides → primary write
    const convergent = await computeRegenerateShotsBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      shotSnapshots: [triggerTimeSnapshot],
    });
    const convergentRecompute = await computeRegenerateShotsBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      shotSnapshots: [triggerTimeSnapshot],
    });
    expect(convergentRecompute).toBe(convergent);

    // Divergent: trigger-time hash differs from write-time recompute → variant
    const divergent = await computeRegenerateShotsBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      shotSnapshots: [writeTimeSnapshot],
    });
    expect(divergent).not.toBe(convergent);
  });

  it('detects tampering with characterRefs even when snapshotInputHash matches', async () => {
    const shot = makeShot();
    const original = await buildRegenerateShotSnapshot({
      shot,
      characters: [makeCharacter()],
      locations: NO_LOCATIONS,
      elements: NO_ELEMENTS,
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
    });
    // A tampered payload: same per-shot hash, but characterRefs swapped
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
    const honestHash = await computeRegenerateShotsBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      shotSnapshots: [original],
    });
    const tamperedHash = await computeRegenerateShotsBatchHash({
      sequenceId: 'seq1',
      imageModel: 'nano_banana_2',
      aspectRatio: '16:9',
      shotSnapshots: [tampered],
    });
    expect(tamperedHash).not.toBe(honestHash);
  });
});

describe('buildConvergentWrites', () => {
  it('records the snapshot hash on the shot and resets variant divergence', () => {
    const writes = buildConvergentWrites('hash-abc');
    expect(writes.shot).toEqual({ thumbnailInputHash: 'hash-abc' });
    expect(writes.variant).toEqual({
      inputHash: 'hash-abc',
      divergedAt: null,
    });
  });
});

describe('buildDivergentWrites', () => {
  it('reverts the speculative primary (shot + variant) and emits an alternate row payload', () => {
    const at = new Date('2026-04-30T00:00:00Z');
    const writes = buildDivergentWrites('hash-xyz', at);

    // Shot row: primary thumbnail fully cleared so the next reconciliation
    // regenerates from current inputs and the user's live edits keep
    // ownership.
    expect(writes.shot).toEqual({
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
    // shotId/sequenceId/variantType/model/url; the helper marks divergence.
    expect(writes.divergentRow).toEqual({
      inputHash: 'hash-xyz',
      divergedAt: at,
      status: 'completed',
    });
  });
});

// `validateSnapshotPayload` lived in the QStash `scoped-workflow` middleware
// (removed in the Cloudflare Workflows cutover). Cloudflare workflows validate
// the snapshot hash inline at `runImpl` start — see
// `regenerate-shots-workflow.ts`.
