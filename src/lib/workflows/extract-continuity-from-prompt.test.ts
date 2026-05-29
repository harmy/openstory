import { describe, expect, it } from 'vitest';
import {
  extractContinuityFromPrompt,
  hasContinuityAdditions,
  mergeContinuityAdditions,
} from './extract-continuity-from-prompt';
import type { Continuity } from '@/lib/ai/scene-analysis.schema';
import type { SequenceElementMinimal } from '@/lib/db/schema';

const el = (token: string): SequenceElementMinimal => ({
  id: `el_${token}`,
  token,
  description: '',
  imageUrl: '',
  consistencyTag: null,
});

const emptyContinuity: Continuity = {
  characterTags: [],
  environmentTag: '',
  elementTags: [],
  colorPalette: '',
  lightingSetup: '',
  styleTag: '',
};

const baseArgs = {
  characters: [],
  elements: [],
  locations: [],
  existing: {
    characterTags: [] as string[],
    elementTags: [] as string[],
    environmentTag: '',
  },
};

describe('extractContinuityFromPrompt', () => {
  it('matches an element token as a whole word', () => {
    const result = extractContinuityFromPrompt({
      ...baseArgs,
      promptText: 'A logo close-up of the LOGO on the table.',
      elements: [el('LOGO')],
    });
    expect(result.elementTags).toEqual(['LOGO']);
  });

  it('does not match an element token inside a larger word', () => {
    const result = extractContinuityFromPrompt({
      ...baseArgs,
      promptText: 'A LOGOLOGO repeating pattern.',
      elements: [el('LOGO')],
    });
    expect(result.elementTags).toEqual([]);
  });

  it('skips elements already in existing tags', () => {
    const result = extractContinuityFromPrompt({
      ...baseArgs,
      promptText: 'Featuring LOGO and BOTTLE.',
      elements: [el('LOGO'), el('BOTTLE')],
      existing: { ...baseArgs.existing, elementTags: ['LOGO'] },
    });
    expect(result.elementTags).toEqual(['BOTTLE']);
  });

  it('matches a character by characterId', () => {
    const result = extractContinuityFromPrompt({
      ...baseArgs,
      promptText: 'char_001 walks into frame.',
      characters: [{ characterId: 'char_001', consistencyTag: null }],
    });
    expect(result.characterTags).toEqual(['char_001']);
  });

  it('matches a character by consistencyTag slug (after colon prefix)', () => {
    const result = extractContinuityFromPrompt({
      ...baseArgs,
      promptText: 'Tight shot of jack-denim-jacket leaning on the bar.',
      characters: [
        {
          characterId: 'char_001',
          consistencyTag: 'char_001: jack-denim-jacket',
        },
      ],
    });
    expect(result.characterTags).toEqual(['jack-denim-jacket']);
  });

  it('character matching is case-insensitive', () => {
    const result = extractContinuityFromPrompt({
      ...baseArgs,
      promptText: 'CHAR_001 looks up.',
      characters: [{ characterId: 'char_001', consistencyTag: null }],
    });
    expect(result.characterTags).toEqual(['char_001']);
  });

  it('skips characters already linked', () => {
    const result = extractContinuityFromPrompt({
      ...baseArgs,
      promptText: 'char_001 and char_002 meet.',
      characters: [
        { characterId: 'char_001', consistencyTag: null },
        { characterId: 'char_002', consistencyTag: null },
      ],
      existing: { ...baseArgs.existing, characterTags: ['char_001'] },
    });
    expect(result.characterTags).toEqual(['char_002']);
  });

  it('returns a single location term when environmentTag is empty', () => {
    const result = extractContinuityFromPrompt({
      ...baseArgs,
      promptText: 'Set at office-modern-steel at sunset.',
      locations: [
        {
          locationId: 'loc_001',
          consistencyTag: 'loc_001: office-modern-steel',
        },
      ],
    });
    expect(result.environmentTag).toBe('office-modern-steel');
  });

  it('skips a location term already contained in environmentTag', () => {
    const result = extractContinuityFromPrompt({
      ...baseArgs,
      promptText: 'Back in office-modern-steel for the meeting.',
      locations: [
        {
          locationId: 'loc_001',
          consistencyTag: 'loc_001: office-modern-steel',
        },
      ],
      existing: {
        ...baseArgs.existing,
        environmentTag: 'office-modern-steel-glass',
      },
    });
    // `office-modern-steel` is a substring of the existing tag, so we don't
    // double-link.
    expect(result.environmentTag).toBeNull();
  });

  it('picks the location term that appears earliest in the prompt', () => {
    const result = extractContinuityFromPrompt({
      ...baseArgs,
      promptText: 'Open in rooftop-bar then cut to office-modern-steel.',
      locations: [
        {
          locationId: 'loc_001',
          consistencyTag: 'loc_001: office-modern-steel',
        },
        { locationId: 'loc_002', consistencyTag: 'loc_002: rooftop-bar' },
      ],
    });
    expect(result.environmentTag).toBe('rooftop-bar');
  });

  it('returns no additions for an empty prompt', () => {
    const result = extractContinuityFromPrompt({
      ...baseArgs,
      promptText: '   ',
      elements: [el('LOGO')],
      characters: [{ characterId: 'char_001', consistencyTag: null }],
      locations: [{ locationId: 'loc_001', consistencyTag: 'loc_001: office' }],
    });
    expect(hasContinuityAdditions(result)).toBe(false);
  });
});

describe('mergeContinuityAdditions', () => {
  it('appends new character and element tags', () => {
    const merged = mergeContinuityAdditions(
      {
        ...emptyContinuity,
        characterTags: ['girl_one'],
        elementTags: ['LOGO'],
      },
      {
        characterTags: ['char_001'],
        elementTags: ['BOTTLE'],
        environmentTag: null,
      }
    );
    expect(merged.characterTags).toEqual(['girl_one', 'char_001']);
    expect(merged.elementTags).toEqual(['LOGO', 'BOTTLE']);
  });

  it('sets environmentTag when current value is empty', () => {
    const merged = mergeContinuityAdditions(
      { ...emptyContinuity, environmentTag: '' },
      { characterTags: [], elementTags: [], environmentTag: 'office-modern' }
    );
    expect(merged.environmentTag).toBe('office-modern');
  });

  it('space-appends a new environmentTag onto the existing one', () => {
    const merged = mergeContinuityAdditions(
      { ...emptyContinuity, environmentTag: 'rooftop-bar' },
      { characterTags: [], elementTags: [], environmentTag: 'office-modern' }
    );
    expect(merged.environmentTag).toBe('rooftop-bar office-modern');
  });

  it('is a no-op when there is nothing to add', () => {
    const base: Continuity = {
      ...emptyContinuity,
      characterTags: ['girl_one'],
      elementTags: ['LOGO'],
      environmentTag: 'rooftop-bar',
    };
    const merged = mergeContinuityAdditions(base, {
      characterTags: [],
      elementTags: [],
      environmentTag: null,
    });
    expect(merged).toEqual(base);
  });
});
