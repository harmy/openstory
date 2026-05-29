import { describe, expect, it } from 'vitest';
import type { StyleConfig } from '@/lib/db/schema';
import {
  computeMotionPromptInputHash,
  computeVisualPromptInputHash,
} from '../input-hash';
import { narrowFramePromptContext } from '../prompt-context';
import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  Scene,
} from '../scene-analysis.schema';

const style: StyleConfig = {
  mood: 'neutral',
  artStyle: 'cinematic',
  lighting: 'natural',
  colorPalette: ['neutral'],
  cameraWork: 'static',
  referenceFilms: [],
  colorGrading: 'neutral',
};

const alice: CharacterBibleEntry = {
  characterId: 'alice',
  name: 'Alice',
  age: '30',
  gender: '',
  ethnicity: '',
  physicalDescription: '',
  standardClothing: '',
  distinguishingFeatures: '',
  consistencyTag: '',
};
const bob: CharacterBibleEntry = { ...alice, characterId: 'bob', name: 'Bob' };

const beach: LocationBibleEntry = {
  locationId: 'beach',
  name: 'Beach',
  type: 'exterior',
  timeOfDay: '',
  description: '',
  architecturalStyle: '',
  keyFeatures: '',
  colorPalette: '',
  lightingSetup: '',
  ambiance: '',
  consistencyTag: '',
  firstMention: { sceneId: '', text: '', lineNumber: 0 },
};
const forest: LocationBibleEntry = {
  ...beach,
  locationId: 'forest',
  name: 'Forest',
  firstMention: { sceneId: '', text: '', lineNumber: 0 },
};

const logo: ElementBibleEntry = {
  token: 'LOGO',
  description: 'Red hex logo',
  consistencyTag: 'red-hex-logo',
  firstMention: { sceneId: 's1', text: 'LOGO', lineNumber: 1 },
};
const bottle: ElementBibleEntry = {
  token: 'BOTTLE',
  description: 'Silver bottle',
  consistencyTag: 'silver-bottle',
  firstMention: { sceneId: 's1', text: 'BOTTLE', lineNumber: 1 },
};

function sceneReferencing(opts: {
  characterTags?: string[];
  environmentTag?: string;
  elementTags?: string[];
  script?: string;
  location?: string;
  durationSeconds?: number;
}): Scene {
  return {
    sceneId: 's1',
    sceneNumber: 1,
    originalScript: { extract: opts.script ?? '', dialogue: [] },
    metadata: {
      title: 'Test scene',
      durationSeconds: opts.durationSeconds ?? 5,
      location: opts.location ?? '',
      timeOfDay: '',
      storyBeat: '',
    },
    continuity: {
      characterTags: opts.characterTags ?? [],
      environmentTag: opts.environmentTag ?? '',
      elementTags: opts.elementTags ?? [],
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
  };
}

describe('narrowFramePromptContext', () => {
  it('keeps only the character entries the scene references', () => {
    const ctx = {
      scene: sceneReferencing({ characterTags: ['alice'] }),
      styleConfig: style,
      characterBible: [alice, bob],
      locationBible: [],
      elementBible: [],
      aspectRatio: '16:9',
      analysisModel: 'anthropic/claude-haiku-4.5',
    };
    const narrowed = narrowFramePromptContext(ctx);
    expect(narrowed.characterBible.map((c) => c.characterId)).toEqual([
      'alice',
    ]);
  });

  it('keeps only the location entries that match environmentTag or scene location', () => {
    const ctx = {
      scene: sceneReferencing({ environmentTag: 'beach' }),
      styleConfig: style,
      characterBible: [],
      locationBible: [beach, forest],
      elementBible: [],
      aspectRatio: '16:9',
      analysisModel: 'anthropic/claude-haiku-4.5',
    };
    const narrowed = narrowFramePromptContext(ctx);
    expect(narrowed.locationBible.map((l) => l.locationId)).toEqual(['beach']);
  });

  it('keeps only the element entries this scene tags or mentions in its script', () => {
    const ctx = {
      scene: sceneReferencing({ elementTags: ['LOGO'] }),
      styleConfig: style,
      characterBible: [],
      locationBible: [],
      elementBible: [logo, bottle],
      aspectRatio: '16:9',
      analysisModel: 'anthropic/claude-haiku-4.5',
    };
    const narrowed = narrowFramePromptContext(ctx);
    expect(narrowed.elementBible.map((e) => e.token)).toEqual(['LOGO']);
  });

  it('returns the full context unchanged when continuity is absent', () => {
    const ctx = {
      scene: {
        sceneId: 's1',
        sceneNumber: 1,
        originalScript: { extract: '', dialogue: [] },
      } as Scene,
      styleConfig: style,
      characterBible: [alice, bob],
      locationBible: [beach],
      elementBible: [logo],
      aspectRatio: '16:9',
      analysisModel: 'anthropic/claude-haiku-4.5',
    };
    const narrowed = narrowFramePromptContext(ctx);
    expect(narrowed).toEqual(ctx);
  });
});

describe('narrowed hash stability (the user-reported bug)', () => {
  const baseCtx = {
    scene: sceneReferencing({
      characterTags: ['alice'],
      environmentTag: 'beach',
      elementTags: ['LOGO'],
    }),
    styleConfig: style,
    characterBible: [alice],
    locationBible: [beach],
    elementBible: [logo],
    aspectRatio: '16:9',
    analysisModel: 'anthropic/claude-haiku-4.5',
  };

  it('adding an unreferenced element does NOT change the visual hash', async () => {
    const before = await computeVisualPromptInputHash(
      narrowFramePromptContext(baseCtx)
    );
    // Simulate uploading a new element that no scene references yet.
    const after = await computeVisualPromptInputHash(
      narrowFramePromptContext({
        ...baseCtx,
        elementBible: [logo, bottle],
      })
    );
    expect(after).toBe(before);
  });

  it('adding an unreferenced character does NOT change the visual hash', async () => {
    const before = await computeVisualPromptInputHash(
      narrowFramePromptContext(baseCtx)
    );
    const after = await computeVisualPromptInputHash(
      narrowFramePromptContext({
        ...baseCtx,
        characterBible: [alice, bob],
      })
    );
    expect(after).toBe(before);
  });

  it('adding an unreferenced location does NOT change the motion hash', async () => {
    const before = await computeMotionPromptInputHash(
      narrowFramePromptContext(baseCtx)
    );
    const after = await computeMotionPromptInputHash(
      narrowFramePromptContext({
        ...baseCtx,
        locationBible: [beach, forest],
      })
    );
    expect(after).toBe(before);
  });

  it('referencing a new element via continuity tags DOES change the hash', async () => {
    const before = await computeVisualPromptInputHash(
      narrowFramePromptContext({
        ...baseCtx,
        elementBible: [logo, bottle],
      })
    );
    // Same bibles, but now the scene's continuity additionally references BOTTLE.
    const after = await computeVisualPromptInputHash(
      narrowFramePromptContext({
        ...baseCtx,
        scene: sceneReferencing({
          characterTags: ['alice'],
          environmentTag: 'beach',
          elementTags: ['LOGO', 'BOTTLE'],
        }),
        elementBible: [logo, bottle],
      })
    );
    expect(after).not.toBe(before);
  });

  // Issue #767: motion-music-prompts-workflow snaps the duration mid-pipeline
  // (e.g. 7 → 8 for a model that only supports {5, 10}) and overwrites
  // `frame.metadata` after the visual prompt hash was already stored. The
  // visual hash must NOT care about that downstream parameter — duration is
  // hashed by `computeFrameVideoInputHash` where it actually matters.
  it('changing metadata.durationSeconds does NOT change the visual hash', async () => {
    const continuityTags = {
      characterTags: ['alice'],
      environmentTag: 'beach',
      elementTags: ['LOGO'],
    };
    const before = await computeVisualPromptInputHash(
      narrowFramePromptContext({
        ...baseCtx,
        scene: sceneReferencing({ ...continuityTags, durationSeconds: 7 }),
      })
    );
    const after = await computeVisualPromptInputHash(
      narrowFramePromptContext({
        ...baseCtx,
        scene: sceneReferencing({ ...continuityTags, durationSeconds: 8 }),
      })
    );
    expect(after).toBe(before);
  });

  it('changing metadata.durationSeconds does NOT change the motion hash', async () => {
    const continuityTags = {
      characterTags: ['alice'],
      environmentTag: 'beach',
      elementTags: ['LOGO'],
    };
    const before = await computeMotionPromptInputHash(
      narrowFramePromptContext({
        ...baseCtx,
        scene: sceneReferencing({ ...continuityTags, durationSeconds: 7 }),
      })
    );
    const after = await computeMotionPromptInputHash(
      narrowFramePromptContext({
        ...baseCtx,
        scene: sceneReferencing({ ...continuityTags, durationSeconds: 8 }),
      })
    );
    expect(after).toBe(before);
  });
});
