/**
 * Tests for `buildShotImageWorkflowInput` (#547) — the per-shot image input
 * assembly shared by the single-shot regenerate and the bulk add-model paths.
 * Focus on the logic unique to this file: the prompt fallback chain (whose
 * `null` return controls whether a shot is silently skipped by callers), the
 * `variantOnly` flag (the whole safety mechanism of #547), and the `sceneId`
 * fallback. The character/location/element matchers and reference builders are
 * pure and tested separately (scene-matching, *-prompt); here we only check the
 * wiring + ordering.
 */

import { describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { CharacterMinimal, Shot } from '@/lib/db/schema';
import { buildShotImageWorkflowInput } from '@/lib/image/build-shot-image-input';

const NOW = new Date('2026-06-03T00:00:00.000Z');

function makeShot(overrides: Partial<Shot> = {}): Shot {
  return {
    id: 'shot-1',
    sequenceId: 'seq-1',
    sceneId: null,
    shotNumber: null,
    orderIndex: 0,
    description: '',
    durationMs: 3000,
    thumbnailUrl: null,
    thumbnailPath: null,
    thumbnailStatus: 'pending',
    thumbnailWorkflowRunId: null,
    thumbnailGeneratedAt: null,
    thumbnailError: null,
    imageModel: 'nano_banana_2',
    imagePrompt: null,
    variantImageUrl: null,
    variantImageStatus: 'pending',
    variantWorkflowRunId: null,
    variantImageGeneratedAt: null,
    variantImageError: null,
    videoUrl: null,
    videoPath: null,
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
    previewThumbnailUrl: null,
    metadata: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const VISUAL_COMPONENTS = {
  sceneDescription: '',
  subject: '',
  environment: '',
  lighting: '',
  camera: '',
  composition: '',
  style: '',
  technical: '',
  atmosphere: '',
};

/**
 * A complete, fully-typed `Scene`. Built as a plain literal (the `: Scene`
 * return type makes tsgo enforce completeness at compile time) rather than via
 * `schema.parse()` — so the fixture never leans on `.catch()` defaults filling
 * missing keys, a behavior that isn't portable across zod versions.
 */
function makeScene(
  opts: { sceneId?: string; visualFullPrompt?: string } = {}
): Scene {
  return {
    sceneId: opts.sceneId ?? 'scene-1',
    sceneNumber: 1,
    originalScript: { extract: '', dialogue: [] },
    metadata: {
      title: 'Scene',
      durationSeconds: 3,
      location: '',
      timeOfDay: '',
      storyBeat: '',
    },
    prompts: {
      visual: {
        fullPrompt: opts.visualFullPrompt ?? '',
        negativePrompt: '',
        components: VISUAL_COMPONENTS,
      },
    },
  };
}

const baseOpts = {
  model: DEFAULT_IMAGE_MODEL,
  userId: 'user-1',
  teamId: 'team-1',
  sequenceId: 'seq-1',
  aspectRatio: '16:9' as const,
  characters: [] as CharacterMinimal[],
  locations: [],
  elements: [],
};

describe('buildShotImageWorkflowInput — prompt fallback chain (#547)', () => {
  it('prefers opts.prompt over every stored source', async () => {
    const shot = makeShot({
      imagePrompt: 'STORED',
      description: 'DESC',
      metadata: makeScene({ visualFullPrompt: 'AI' }),
    });
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      shot,
      prompt: 'OVERRIDE',
    });
    expect(input?.prompt).toBe('OVERRIDE');
    expect(input?.sceneSnapshot?.visualPrompt).toBe('OVERRIDE');
  });

  it('falls back to shot.imagePrompt when no override', async () => {
    const shot = makeShot({ imagePrompt: 'STORED', description: 'DESC' });
    const input = await buildShotImageWorkflowInput({ ...baseOpts, shot });
    expect(input?.prompt).toBe('STORED');
  });

  it('falls back to metadata.prompts.visual.fullPrompt before description', async () => {
    const shot = makeShot({
      imagePrompt: null,
      description: 'DESC',
      metadata: makeScene({ visualFullPrompt: 'AI' }),
    });
    const input = await buildShotImageWorkflowInput({ ...baseOpts, shot });
    expect(input?.prompt).toBe('AI');
  });

  it('falls back to shot.description last', async () => {
    const shot = makeShot({ imagePrompt: null, description: 'DESC' });
    const input = await buildShotImageWorkflowInput({ ...baseOpts, shot });
    expect(input?.prompt).toBe('DESC');
  });

  it('returns null when no prompt is available anywhere (caller skips the shot)', async () => {
    const shot = makeShot({
      imagePrompt: null,
      description: '',
      metadata: null,
    });
    const input = await buildShotImageWorkflowInput({ ...baseOpts, shot });
    expect(input).toBeNull();
  });
});

describe('buildShotImageWorkflowInput — variantOnly (#547)', () => {
  it('propagates variantOnly: true', async () => {
    const shot = makeShot({ description: 'DESC' });
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      shot,
      variantOnly: true,
    });
    expect(input?.variantOnly).toBe(true);
  });

  it('defaults variantOnly to false (the single-shot regenerate path keeps writing the primary)', async () => {
    const shot = makeShot({ description: 'DESC' });
    const input = await buildShotImageWorkflowInput({ ...baseOpts, shot });
    expect(input?.variantOnly).toBe(false);
  });
});

describe('buildShotImageWorkflowInput — sceneId + core shape', () => {
  it('uses metadata.sceneId for the snapshot when present', async () => {
    const shot = makeShot({
      description: 'DESC',
      metadata: makeScene({ sceneId: 'scene-xyz' }),
    });
    const input = await buildShotImageWorkflowInput({ ...baseOpts, shot });
    expect(input?.sceneSnapshot?.sceneId).toBe('scene-xyz');
  });

  it('falls back to shot.id when metadata is absent', async () => {
    const shot = makeShot({ id: 'shot-99', description: 'DESC' });
    const input = await buildShotImageWorkflowInput({ ...baseOpts, shot });
    expect(input?.sceneSnapshot?.sceneId).toBe('shot-99');
  });

  it('sets the workflow fields (shotId, sequenceId, numImages, userEditedPrompt default, hash)', async () => {
    const shot = makeShot({ id: 'shot-7', description: 'DESC' });
    const input = await buildShotImageWorkflowInput({ ...baseOpts, shot });
    expect(input?.shotId).toBe('shot-7');
    expect(input?.sequenceId).toBe('seq-1');
    expect(input?.numImages).toBe(1);
    expect(input?.model).toBe(DEFAULT_IMAGE_MODEL);
    expect(input?.userEditedPrompt).toBe(false);
    expect(typeof input?.snapshotInputHash).toBe('string');
    expect(input?.snapshotInputHash?.length).toBeGreaterThan(0);
  });

  it('forwards userEditedPrompt when set', async () => {
    const shot = makeShot({ description: 'DESC' });
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      shot,
      userEditedPrompt: true,
    });
    expect(input?.userEditedPrompt).toBe(true);
  });
});

describe('buildShotImageWorkflowInput — reference images', () => {
  it('has no reference images when nothing matches', async () => {
    const shot = makeShot({ description: 'DESC' });
    const input = await buildShotImageWorkflowInput({ ...baseOpts, shot });
    expect(input?.referenceImages).toEqual([]);
  });

  it('includes a matching character (with a sheet) as a character-role reference', async () => {
    const shot = makeShot({ description: 'DESC' });
    const character: CharacterMinimal = {
      id: 'c1',
      characterId: 'jack',
      name: 'Jack',
      sheetImageUrl: 'https://cdn/jack-sheet.png',
      sheetStatus: 'completed',
      sheetInputHash: 'hash-jack',
      physicalDescription: 'tall',
      consistencyTag: null,
    };
    const input = await buildShotImageWorkflowInput({
      ...baseOpts,
      shot,
      characters: [character],
      // Matching continuity passed directly (avoids building shot metadata).
      continuity: {
        characterTags: ['Jack'],
        environmentTag: '',
        elementTags: [],
        colorPalette: '',
        lightingSetup: '',
        styleTag: '',
      },
    });
    expect(input?.referenceImages?.[0]).toMatchObject({
      referenceImageUrl: 'https://cdn/jack-sheet.png',
      role: 'character',
    });
  });
});
