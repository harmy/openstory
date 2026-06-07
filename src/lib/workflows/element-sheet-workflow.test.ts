import { describe, expect, test } from 'vitest';
import type { ElementBibleEntry } from '@/lib/ai/scene-analysis.schema';
import type { SequenceElementMinimal } from '@/lib/db/schema';
import {
  collectElementResults,
  findMissingElementEntries,
} from './element-sheet-workflow';

const entry = (token: string): ElementBibleEntry => ({
  token,
  description: `Visual description of ${token}`,
  consistencyTag: token.toLowerCase().replaceAll('_', '-'),
  firstMention: { sceneId: 'scene_1', text: `the ${token}`, lineNumber: 1 },
});

describe('findMissingElementEntries', () => {
  test('returns entries whose token has no uploaded element', () => {
    const bible = [entry('LOGO'), entry('CORAL_LIPSTICK')];

    const missing = findMissingElementEntries(bible, [{ token: 'LOGO' }]);

    expect(missing.map((e) => e.token)).toEqual(['CORAL_LIPSTICK']);
  });

  test('returns all entries when nothing was uploaded', () => {
    const bible = [entry('HERO_PRODUCT')];

    expect(findMissingElementEntries(bible, [])).toEqual(bible);
  });

  test('returns nothing when every entry is covered by an upload', () => {
    const bible = [entry('LOGO'), entry('BOTTLE')];
    const uploaded = [{ token: 'LOGO' }, { token: 'BOTTLE' }];

    expect(findMissingElementEntries(bible, uploaded)).toEqual([]);
  });

  test('is exact-match on token (no case folding)', () => {
    const bible = [entry('LOGO')];

    expect(findMissingElementEntries(bible, [{ token: 'logo' }])).toEqual(
      bible
    );
  });
});

describe('collectElementResults', () => {
  const element = (token: string): SequenceElementMinimal => ({
    id: `el_${token.toLowerCase()}`,
    token,
    description: `Visual description of ${token}`,
    imageUrl: `https://storage.example/${token.toLowerCase()}.png`,
    consistencyTag: token.toLowerCase().replaceAll('_', '-'),
  });
  const fulfilled = (
    token: string
  ): PromiseSettledResult<SequenceElementMinimal> => ({
    status: 'fulfilled',
    value: element(token),
  });
  const rejected = (
    reason: Error | string
  ): PromiseSettledResult<SequenceElementMinimal> => ({
    status: 'rejected',
    reason,
  });

  test('returns the elements in entry order when every entry succeeded', () => {
    const settled = [fulfilled('LOGO'), fulfilled('CORAL_LIPSTICK')];

    const elements = collectElementResults(settled, [
      { token: 'LOGO' },
      { token: 'CORAL_LIPSTICK' },
    ]);

    expect(elements.map((e) => e.token)).toEqual(['LOGO', 'CORAL_LIPSTICK']);
  });

  test('throws naming the failed token when any entry failed', () => {
    const settled = [fulfilled('LOGO'), rejected(new Error('fal timeout'))];

    expect(() =>
      collectElementResults(settled, [
        { token: 'LOGO' },
        { token: 'CORAL_LIPSTICK' },
      ])
    ).toThrow(/1\/2.*CORAL_LIPSTICK: fal timeout/);
  });

  test('aggregates every failure into one error', () => {
    const settled = [rejected('quota exceeded'), rejected(new Error('500'))];

    expect(() =>
      collectElementResults(settled, [{ token: 'LOGO' }, { token: 'BOTTLE' }])
    ).toThrow(/2\/2.*LOGO: quota exceeded; BOTTLE: 500/);
  });
});
