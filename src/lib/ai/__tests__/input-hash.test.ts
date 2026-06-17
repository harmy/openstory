import { describe, expect, it } from 'vitest';
import type {
  CharacterBibleEntry,
  LocationBibleEntry,
  Scene,
} from '../scene-analysis.schema';
import type { StyleConfig } from '@/lib/db/schema';
import type { MusicSceneSummary } from '@/lib/workflow/types';
import {
  computeCharacterSheetInputHash,
  computeFrameAudioInputHash,
  computeFrameImageInputHash,
  computeFrameVideoInputHash,
  computeLibraryLocationReferenceInputHash,
  computeLocationSheetInputHash,
  computeMotionPromptInputHash,
  computeMusicPromptInputHash,
  computeSequenceMusicInputHash,
  computeTalentSheetInputHash,
  computeVisualPromptInputHash,
  type CharacterSheetHashInput,
  type FrameAudioHashInput,
  type FrameImageHashInput,
  type FrameVideoHashInput,
  type LibraryLocationReferenceHashInput,
  type LocationSheetHashInput,
  type TalentSheetHashInput,
} from '../input-hash';

const baseThumbnail: FrameImageHashInput = {
  kind: 'thumbnail',
  visualPrompt: 'A detective in a rainy alley, neon reflections',
  imageModel: 'flux-pro-v1.1',
  aspectRatio: '16:9',
  size: '1920x1080',
  seed: 42,
  characterSheetHashes: ['char-a', 'char-b'],
  locationSheetHashes: ['loc-1'],
  elementReferenceHashes: ['el-x'],
};

const SHA256_HEX = /^[0-9a-f]{64}$/;

describe('computeFrameImageInputHash (thumbnail)', () => {
  it('produces a 64-char hex SHA-256 digest', async () => {
    const hash = await computeFrameImageInputHash(baseThumbnail);
    expect(hash).toMatch(SHA256_HEX);
  });

  it('returns the same hash for identical input', async () => {
    const a = await computeFrameImageInputHash(baseThumbnail);
    const b = await computeFrameImageInputHash({ ...baseThumbnail });
    expect(a).toBe(b);
  });

  it('is order-insensitive for character sheet refs', async () => {
    const a = await computeFrameImageInputHash(baseThumbnail);
    const b = await computeFrameImageInputHash({
      ...baseThumbnail,
      characterSheetHashes: ['char-b', 'char-a'],
    });
    expect(a).toBe(b);
  });

  it('trims free-text prompts', async () => {
    const a = await computeFrameImageInputHash(baseThumbnail);
    const b = await computeFrameImageInputHash({
      ...baseThumbnail,
      visualPrompt: `   ${baseThumbnail.visualPrompt}\n`,
    });
    expect(a).toBe(b);
  });

  it('changes when the visual prompt changes', async () => {
    const a = await computeFrameImageInputHash(baseThumbnail);
    const b = await computeFrameImageInputHash({
      ...baseThumbnail,
      visualPrompt: `${baseThumbnail.visualPrompt} at dawn`,
    });
    expect(a).not.toBe(b);
  });

  it('changes when the image model version changes', async () => {
    const a = await computeFrameImageInputHash(baseThumbnail);
    const b = await computeFrameImageInputHash({
      ...baseThumbnail,
      imageModel: 'flux-pro-v1.2',
    });
    expect(a).not.toBe(b);
  });

  it('changes when the aspect ratio, size, or seed changes', async () => {
    const base = await computeFrameImageInputHash(baseThumbnail);
    const aspect = await computeFrameImageInputHash({
      ...baseThumbnail,
      aspectRatio: '9:16',
    });
    const size = await computeFrameImageInputHash({
      ...baseThumbnail,
      size: '1280x720',
    });
    const seed = await computeFrameImageInputHash({
      ...baseThumbnail,
      seed: 99,
    });
    expect(new Set([base, aspect, size, seed]).size).toBe(4);
  });

  it('changes when a referenced character sheet hash changes', async () => {
    const a = await computeFrameImageInputHash(baseThumbnail);
    const b = await computeFrameImageInputHash({
      ...baseThumbnail,
      characterSheetHashes: ['char-a', 'char-b-NEW'],
    });
    expect(a).not.toBe(b);
  });

  it('changes when location or element refs change', async () => {
    const a = await computeFrameImageInputHash(baseThumbnail);
    const loc = await computeFrameImageInputHash({
      ...baseThumbnail,
      locationSheetHashes: ['loc-2'],
    });
    const el = await computeFrameImageInputHash({
      ...baseThumbnail,
      elementReferenceHashes: ['el-y'],
    });
    expect(new Set([a, loc, el]).size).toBe(3);
  });

  it('treats null and missing optional scalars identically', async () => {
    const explicitNulls = await computeFrameImageInputHash({
      ...baseThumbnail,
      size: null,
      seed: null,
    });
    const omitted = await computeFrameImageInputHash({
      kind: baseThumbnail.kind,
      visualPrompt: baseThumbnail.visualPrompt,
      imageModel: baseThumbnail.imageModel,
      aspectRatio: baseThumbnail.aspectRatio,
      characterSheetHashes: baseThumbnail.characterSheetHashes,
      locationSheetHashes: baseThumbnail.locationSheetHashes,
      elementReferenceHashes: baseThumbnail.elementReferenceHashes,
    });
    expect(explicitNulls).toBe(omitted);
  });
});

describe('computeFrameImageInputHash (variant-image)', () => {
  it('is distinct from the thumbnail hash for the same input', async () => {
    const thumb = await computeFrameImageInputHash(baseThumbnail);
    const variant = await computeFrameImageInputHash({
      ...baseThumbnail,
      kind: 'variant-image',
    });
    expect(variant).toMatch(SHA256_HEX);
    expect(variant).not.toBe(thumb);
  });

  it('is stable and sensitive to model change', async () => {
    const variantBase: FrameImageHashInput = {
      ...baseThumbnail,
      kind: 'variant-image',
    };
    const a = await computeFrameImageInputHash(variantBase);
    const same = await computeFrameImageInputHash({ ...variantBase });
    const different = await computeFrameImageInputHash({
      ...variantBase,
      imageModel: 'sdxl-v1',
    });
    expect(a).toBe(same);
    expect(a).not.toBe(different);
  });
});

describe('computeFrameVideoInputHash', () => {
  const base: FrameVideoHashInput = {
    sourceImage: { kind: 'variantHash', hash: 'sha-source-image' },
    motionPrompt: 'Slow dolly forward',
    motionModel: 'kling-v2.5-turbo-pro',
    durationSeconds: 5,
    fps: 30,
    aspectRatio: '16:9',
  };

  it('is stable for identical input', async () => {
    expect(await computeFrameVideoInputHash(base)).toBe(
      await computeFrameVideoInputHash({ ...base })
    );
  });

  it('changes when the motion model version changes', async () => {
    const a = await computeFrameVideoInputHash(base);
    const b = await computeFrameVideoInputHash({
      ...base,
      motionModel: 'kling-v2.6-turbo-pro',
    });
    expect(a).not.toBe(b);
  });

  it('reacts to every tracked field', async () => {
    const variants = await Promise.all([
      computeFrameVideoInputHash(base),
      computeFrameVideoInputHash({
        ...base,
        sourceImage: { kind: 'variantHash', hash: 'sha-other' },
      }),
      computeFrameVideoInputHash({ ...base, motionPrompt: 'Pan left' }),
      computeFrameVideoInputHash({ ...base, durationSeconds: 8 }),
      computeFrameVideoInputHash({ ...base, fps: 60 }),
      computeFrameVideoInputHash({ ...base, aspectRatio: '9:16' }),
    ]);
    expect(new Set(variants).size).toBe(variants.length);
  });

  it('distinguishes variantHash from url even when the string matches', async () => {
    const fromHash = await computeFrameVideoInputHash({
      ...base,
      sourceImage: { kind: 'variantHash', hash: 'shared-string' },
    });
    const fromUrl = await computeFrameVideoInputHash({
      ...base,
      sourceImage: { kind: 'url', url: 'shared-string' },
    });
    expect(fromHash).not.toBe(fromUrl);
  });
});

describe('computeFrameAudioInputHash', () => {
  const base: FrameAudioHashInput = {
    musicPrompt: 'Tense orchestral build',
    tags: ['cinematic', 'tension'],
    durationSeconds: 5,
    audioModel: 'cassette-v1',
  };

  it('is order-insensitive for tags', async () => {
    const a = await computeFrameAudioInputHash(base);
    const b = await computeFrameAudioInputHash({
      ...base,
      tags: ['tension', 'cinematic'],
    });
    expect(a).toBe(b);
  });

  it('reacts to prompt, duration, and model', async () => {
    const a = await computeFrameAudioInputHash(base);
    const prompt = await computeFrameAudioInputHash({
      ...base,
      musicPrompt: 'Soft piano',
    });
    const dur = await computeFrameAudioInputHash({
      ...base,
      durationSeconds: 9,
    });
    const model = await computeFrameAudioInputHash({
      ...base,
      audioModel: 'cassette-v2',
    });
    expect(new Set([a, prompt, dur, model]).size).toBe(4);
  });
});

describe('computeCharacterSheetInputHash', () => {
  const base: CharacterSheetHashInput = {
    characterBible: {
      name: 'Detective Sarah',
      age: '30s',
      gender: 'female',
      ethnicity: '',
      physicalDescription: 'tall, blonde, blue eyes',
      standardClothing: 'dark trench coat',
      distinguishingFeatures: 'scar above right eye',
      consistencyTag: 'sarah_blonde_30s',
    },
    talentSheetHash: 'talent-sha',
    styleConfigHash: 'style-sha',
    imageModel: 'flux-pro-v1.1',
  };

  it('is stable and sensitive to bible field changes', async () => {
    const a = await computeCharacterSheetInputHash(base);
    const same = await computeCharacterSheetInputHash({ ...base });
    const renamed = await computeCharacterSheetInputHash({
      ...base,
      characterBible: { ...base.characterBible, name: 'Detective Linda' },
    });
    expect(a).toBe(same);
    expect(a).not.toBe(renamed);
  });

  it('reacts to talent hash, style config, and image model', async () => {
    const a = await computeCharacterSheetInputHash(base);
    const talent = await computeCharacterSheetInputHash({
      ...base,
      talentSheetHash: 'talent-sha-v2',
    });
    const style = await computeCharacterSheetInputHash({
      ...base,
      styleConfigHash: 'style-sha-v2',
    });
    const model = await computeCharacterSheetInputHash({
      ...base,
      imageModel: 'sdxl-v1',
    });
    expect(new Set([a, talent, style, model]).size).toBe(4);
  });

  it('treats null and missing talent hash identically', async () => {
    const nullHash = await computeCharacterSheetInputHash({
      ...base,
      talentSheetHash: null,
    });
    const omitted = await computeCharacterSheetInputHash({
      characterBible: base.characterBible,
      styleConfigHash: base.styleConfigHash,
      imageModel: base.imageModel,
    });
    expect(nullHash).toBe(omitted);
  });
});

describe('computeLocationSheetInputHash', () => {
  const base: LocationSheetHashInput = {
    locationBible: { name: 'Office', description: 'Modern open-plan, glass' },
    libraryLocationReferenceHash: 'lib-sha',
    styleConfigHash: 'style-sha',
    imageModel: 'flux-pro-v1.1',
  };

  it('reacts to bible, library ref, style, and model', async () => {
    const a = await computeLocationSheetInputHash(base);
    const variants = await Promise.all([
      computeLocationSheetInputHash({
        ...base,
        locationBible: { ...base.locationBible, name: 'Warehouse' },
      }),
      computeLocationSheetInputHash({
        ...base,
        libraryLocationReferenceHash: 'lib-sha-v2',
      }),
      computeLocationSheetInputHash({
        ...base,
        styleConfigHash: 'style-sha-v2',
      }),
      computeLocationSheetInputHash({ ...base, imageModel: 'sdxl-v1' }),
    ]);
    expect(new Set([a, ...variants]).size).toBe(5);
  });
});

describe('computeLibraryLocationReferenceInputHash', () => {
  const base: LibraryLocationReferenceHashInput = {
    locationBible: { name: 'Office', description: 'Modern open-plan, glass' },
    styleConfigHash: 'style-sha',
    imageModel: 'flux-pro-v1.1',
  };

  it('is stable, distinct from sheet hash, and reacts to model', async () => {
    const ref = await computeLibraryLocationReferenceInputHash(base);
    const refSame = await computeLibraryLocationReferenceInputHash({ ...base });
    const sheetEquivalent = await computeLocationSheetInputHash({
      ...base,
      libraryLocationReferenceHash: null,
    });
    const refModel = await computeLibraryLocationReferenceInputHash({
      ...base,
      imageModel: 'sdxl-v1',
    });
    expect(ref).toBe(refSame);
    expect(ref).not.toBe(sheetEquivalent);
    expect(ref).not.toBe(refModel);
  });
});

describe('computeTalentSheetInputHash', () => {
  const base: TalentSheetHashInput = {
    talent: { name: 'Talent Name', description: 'Headshot reference' },
    referenceMediaHashes: ['m1', 'm2', 'm3'],
    imageModel: 'flux-pro-v1.1',
  };

  it('is order-insensitive for reference media', async () => {
    const a = await computeTalentSheetInputHash(base);
    const b = await computeTalentSheetInputHash({
      ...base,
      referenceMediaHashes: ['m3', 'm1', 'm2'],
    });
    expect(a).toBe(b);
  });

  it('reacts to talent fields, media set, and image model', async () => {
    const a = await computeTalentSheetInputHash(base);
    const variants = await Promise.all([
      computeTalentSheetInputHash({
        ...base,
        talent: { ...base.talent, name: 'Other Talent' },
      }),
      computeTalentSheetInputHash({
        ...base,
        referenceMediaHashes: ['m1', 'm2', 'm4'],
      }),
      computeTalentSheetInputHash({ ...base, imageModel: 'sdxl-v1' }),
    ]);
    expect(new Set([a, ...variants]).size).toBe(4);
  });
});

describe('artifact discrimination', () => {
  it('returns different hashes for different artifact types with the same input shape', async () => {
    // Frame audio and video share several scalar fields; the artifact tag in
    // the canonical body keeps them distinct.
    const audio = await computeFrameAudioInputHash({
      musicPrompt: '',
      tags: [],
      durationSeconds: 5,
      audioModel: 'shared',
    });
    const video = await computeFrameVideoInputHash({
      sourceImage: { kind: 'url', url: '' },
      motionPrompt: '',
      motionModel: 'shared',
      durationSeconds: 5,
      fps: null,
      aspectRatio: '',
    });
    expect(audio).not.toBe(video);
  });
});

describe('canonical serialization', () => {
  it('produces the same digest regardless of key insertion order', async () => {
    const ordered = await computeCharacterSheetInputHash({
      characterBible: {
        name: 'Alice',
        age: '30s',
        gender: 'female',
        ethnicity: '',
        physicalDescription: 'tall',
        standardClothing: 'jacket',
        distinguishingFeatures: 'scar',
        consistencyTag: 'alice_30s',
      },
      talentSheetHash: 'talent',
      styleConfigHash: 'style',
      imageModel: 'flux-pro',
    });
    // Same fields, declared in a different order at every level.
    const shuffled = await computeCharacterSheetInputHash({
      imageModel: 'flux-pro',
      styleConfigHash: 'style',
      talentSheetHash: 'talent',
      characterBible: {
        consistencyTag: 'alice_30s',
        distinguishingFeatures: 'scar',
        standardClothing: 'jacket',
        physicalDescription: 'tall',
        ethnicity: '',
        gender: 'female',
        age: '30s',
        name: 'Alice',
      },
    });
    expect(ordered).toBe(shuffled);
  });

  it('rejects non-finite numbers rather than collapsing them to null', () => {
    expect(
      computeFrameAudioInputHash({
        musicPrompt: 'test',
        tags: [],
        durationSeconds: Number.NaN,
        audioModel: 'cassette-v1',
      })
    ).rejects.toThrow(/non-finite/);
    expect(
      computeFrameAudioInputHash({
        musicPrompt: 'test',
        tags: [],
        durationSeconds: Number.POSITIVE_INFINITY,
        audioModel: 'cassette-v1',
      })
    ).rejects.toThrow(/non-finite/);
  });
});

describe('prompt input hashes', () => {
  const minimalScene: Scene = {
    sceneId: 's1',
    sceneNumber: 1,
    originalScript: { extract: '', dialogue: [] },
  };

  const minimalStyle: StyleConfig = {
    mood: 'neutral',
    artStyle: 'cinematic',
    lighting: 'natural',
    colorPalette: ['neutral'],
    cameraWork: 'static',
    referenceFilms: [],
    colorGrading: 'neutral',
  };

  const aliceCharacter: CharacterBibleEntry = {
    characterId: 'c1',
    name: 'Alice',
    age: '30',
    gender: '',
    ethnicity: '',
    physicalDescription: '',
    standardClothing: '',
    distinguishingFeatures: '',
    consistencyTag: '',
  };

  const beachLocation: LocationBibleEntry = {
    locationId: 'l1',
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

  const sceneCtx = {
    scene: minimalScene,
    styleConfig: minimalStyle,
    characterBible: [aliceCharacter],
    locationBible: [beachLocation],
    elementBible: [],
    aspectRatio: '16:9',
    analysisModel: 'anthropic/claude-haiku-4.5',
  };

  it('visual and motion prompt hashes are namespaced by artifact and differ', async () => {
    const visual = await computeVisualPromptInputHash(sceneCtx);
    const motion = await computeMotionPromptInputHash(sceneCtx);
    expect(visual).not.toBe(motion);
    expect(visual).toMatch(/^[0-9a-f]{64}$/);
    expect(motion).toMatch(/^[0-9a-f]{64}$/);
  });

  it('motion prompt hash changes when the rendered starting frame changes (#929)', async () => {
    const baseline = await computeMotionPromptInputHash(sceneCtx);
    const withImage = await computeMotionPromptInputHash({
      ...sceneCtx,
      startingFrameImageUrl: '/r2/frames/a.png',
    });
    const withReRenderedImage = await computeMotionPromptInputHash({
      ...sceneCtx,
      startingFrameImageUrl: '/r2/frames/b.png',
    });
    // Absent vs present, and present-A vs present-B, must all differ so a
    // re-rendered still (new URL) re-stales the motion prompt.
    expect(withImage).not.toBe(baseline);
    expect(withReRenderedImage).not.toBe(withImage);
  });

  it('omitting startingFrameImageUrl equals passing null (legacy frames)', async () => {
    const omitted = await computeMotionPromptInputHash(sceneCtx);
    const explicitNull = await computeMotionPromptInputHash({
      ...sceneCtx,
      startingFrameImageUrl: null,
    });
    expect(omitted).toBe(explicitNull);
  });

  it('the visual prompt hash ignores the starting frame (it produces the image)', async () => {
    const baseline = await computeVisualPromptInputHash(sceneCtx);
    const withImage = await computeVisualPromptInputHash({
      ...sceneCtx,
      startingFrameImageUrl: '/r2/frames/a.png',
    });
    expect(withImage).toBe(baseline);
  });

  it('bible array order does not affect the visual prompt hash', async () => {
    const second: CharacterBibleEntry = {
      ...aliceCharacter,
      characterId: 'c2',
      name: 'Bob',
    };
    const orderA = await computeVisualPromptInputHash({
      ...sceneCtx,
      characterBible: [aliceCharacter, second],
    });
    const orderB = await computeVisualPromptInputHash({
      ...sceneCtx,
      characterBible: [second, aliceCharacter],
    });
    expect(orderA).toBe(orderB);
  });

  // canonicalize() treats a repeated object reference as a cycle, so each
  // clone needs its own nested firstMention object.
  const cloneLocation = (
    overrides: Partial<LocationBibleEntry>
  ): LocationBibleEntry => ({
    ...beachLocation,
    ...overrides,
    firstMention: { sceneId: '', text: '', lineNumber: 0 },
  });

  it('locationBible order does not affect the visual prompt hash', async () => {
    const first = cloneLocation({});
    const second = cloneLocation({ locationId: 'l2', name: 'Forest' });
    const orderA = await computeVisualPromptInputHash({
      ...sceneCtx,
      locationBible: [first, second],
    });
    const orderB = await computeVisualPromptInputHash({
      ...sceneCtx,
      locationBible: [second, first],
    });
    expect(orderA).toBe(orderB);
  });

  it('elementBible order does not affect the visual prompt hash', async () => {
    const elementA = {
      token: 'LOGO',
      description: 'Red hex logo',
      consistencyTag: 'red-hex-logo',
      firstMention: { sceneId: 's1', text: 'LOGO', lineNumber: 1 },
    };
    const elementB = {
      token: 'BADGE',
      description: 'Police badge',
      consistencyTag: 'police-badge',
      firstMention: { sceneId: 's1', text: 'BADGE', lineNumber: 2 },
    };
    const orderA = await computeVisualPromptInputHash({
      ...sceneCtx,
      elementBible: [elementA, elementB],
    });
    const orderB = await computeVisualPromptInputHash({
      ...sceneCtx,
      elementBible: [elementB, elementA],
    });
    expect(orderA).toBe(orderB);
  });

  it('bible array order does not affect the motion prompt hash (all three bibles)', async () => {
    const characterA: CharacterBibleEntry = { ...aliceCharacter };
    const characterB: CharacterBibleEntry = {
      ...aliceCharacter,
      characterId: 'c2',
      name: 'Bob',
    };
    const locationA = cloneLocation({});
    const locationB = cloneLocation({ locationId: 'l2', name: 'Forest' });
    const elementA = {
      token: 'LOGO',
      description: 'Red hex logo',
      consistencyTag: 'red-hex-logo',
      firstMention: { sceneId: 's1', text: 'LOGO', lineNumber: 1 },
    };
    const elementB = {
      token: 'BADGE',
      description: 'Police badge',
      consistencyTag: 'police-badge',
      firstMention: { sceneId: 's1', text: 'BADGE', lineNumber: 2 },
    };
    const orderA = await computeMotionPromptInputHash({
      ...sceneCtx,
      characterBible: [characterA, characterB],
      locationBible: [locationA, locationB],
      elementBible: [elementA, elementB],
    });
    const orderB = await computeMotionPromptInputHash({
      ...sceneCtx,
      characterBible: [characterB, characterA],
      locationBible: [locationB, locationA],
      elementBible: [elementB, elementA],
    });
    expect(orderA).toBe(orderB);
  });

  it('changing the analysis model changes the visual prompt hash', async () => {
    const a = await computeVisualPromptInputHash(sceneCtx);
    const b = await computeVisualPromptInputHash({
      ...sceneCtx,
      analysisModel: 'anthropic/claude-sonnet-4.6',
    });
    expect(a).not.toBe(b);
  });

  it('elementBible changes flow through to both visual and motion prompt hashes', async () => {
    const withoutElements = sceneCtx;
    const withElement = {
      ...sceneCtx,
      elementBible: [
        {
          token: 'LOGO',
          description: 'Red hex logo',
          consistencyTag: 'red-hex-logo',
          firstMention: { sceneId: 's1', text: 'LOGO', lineNumber: 1 },
        },
      ],
    };

    const visualA = await computeVisualPromptInputHash(withoutElements);
    const visualB = await computeVisualPromptInputHash(withElement);
    const motionA = await computeMotionPromptInputHash(withoutElements);
    const motionB = await computeMotionPromptInputHash(withElement);

    expect(visualA).not.toBe(visualB);
    expect(motionA).not.toBe(motionB);
  });

  const baseSummary: MusicSceneSummary = {
    sceneId: 's1',
    title: 'Opening',
    storyBeat: 'Establish tone',
    durationSeconds: 10,
    location: 'INT. STUDIO - NIGHT',
    timeOfDay: 'night',
    visualSummary: 'Wide shot, low key lighting',
  };

  it('music prompt hash is stable for equivalent inputs and changes with sceneSummaries', async () => {
    const a = await computeMusicPromptInputHash({
      sceneSummaries: [baseSummary],
      analysisModel: 'm',
    });
    const b = await computeMusicPromptInputHash({
      sceneSummaries: [{ ...baseSummary }],
      analysisModel: 'm',
    });
    const c = await computeMusicPromptInputHash({
      sceneSummaries: [{ ...baseSummary, storyBeat: 'Twist reveal' }],
      analysisModel: 'm',
    });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('hash excludes LLM output: same upstream context with different prompts/continuity hashes the same', async () => {
    const upstream = await computeVisualPromptInputHash(sceneCtx);
    const enriched = await computeVisualPromptInputHash({
      ...sceneCtx,
      scene: {
        ...minimalScene,
        prompts: {
          visual: {
            fullPrompt: 'A wholly different prompt produced by the LLM',
            negativePrompt: 'blurry',
            components: {
              sceneDescription: 'foo',
              subject: 'bar',
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
        continuity: {
          characterTags: ['alice'],
          environmentTag: 'beach',
          colorPalette: 'warm',
          lightingSetup: 'golden hour',
          styleTag: 'cinematic',
        },
      },
    });
    expect(upstream).toBe(enriched);

    const motionUpstream = await computeMotionPromptInputHash(sceneCtx);
    const motionEnriched = await computeMotionPromptInputHash({
      ...sceneCtx,
      scene: {
        ...minimalScene,
        prompts: {
          motion: {
            fullPrompt: 'Camera dolly in slowly',
            components: {
              cameraMovement: 'dolly',
              startPosition: '',
              endPosition: '',
              durationSeconds: 5,
              speed: 'slow',
              smoothness: 'smooth',
              subjectTracking: '',
              equipment: '',
            },
            parameters: {
              durationSeconds: 5,
              fps: 30,
              motionAmount: 'medium',
              cameraControl: { pan: 0, tilt: 0, zoom: 0, movement: '' },
            },
          },
        },
      },
    });
    expect(motionUpstream).toBe(motionEnriched);
  });
});

describe('computeSequenceMusicInputHash', () => {
  const base = {
    prompt: 'Cinematic orchestral build',
    tags: 'cinematic,tension,strings',
    durationSeconds: 60,
    audioModel: 'cassette-v1',
  };

  it('is stable for identical input', async () => {
    const a = await computeSequenceMusicInputHash(base);
    const b = await computeSequenceMusicInputHash({ ...base });
    expect(a).toBe(b);
  });

  it('reacts to prompt, tags, duration, and model', async () => {
    const a = await computeSequenceMusicInputHash(base);
    const prompt = await computeSequenceMusicInputHash({
      ...base,
      prompt: 'Soft piano',
    });
    const tags = await computeSequenceMusicInputHash({
      ...base,
      tags: 'piano,calm',
    });
    const duration = await computeSequenceMusicInputHash({
      ...base,
      durationSeconds: 90,
    });
    const model = await computeSequenceMusicInputHash({
      ...base,
      audioModel: 'cassette-v2',
    });
    expect(new Set([a, prompt, tags, duration, model]).size).toBe(5);
  });

  it('trims leading/trailing whitespace on prompt and tags', async () => {
    const trimmed = await computeSequenceMusicInputHash(base);
    const padded = await computeSequenceMusicInputHash({
      ...base,
      prompt: '  Cinematic orchestral build  ',
      tags: '\tcinematic,tension,strings\n',
    });
    expect(padded).toBe(trimmed);
  });
});
