import { describe, expect, it } from 'vitest';
import {
  stillFlagLabels,
  stillRejected,
  stillVerdictSchema,
} from './score-image';

describe('stillVerdictSchema', () => {
  it('defaults omitted flags/note to false/empty', () => {
    const v = stillVerdictSchema.parse({ styleAdherence: 8 });
    expect(v).toMatchObject({
      styleAdherence: 8,
      literalMedium: false,
      multiFrame: false,
      anatomy: false,
      unwantedText: false,
      note: '',
    });
  });
});

describe('stillRejected', () => {
  const base = stillVerdictSchema.parse({ styleAdherence: 8 });
  it('rejects on a hard artifact or gross anatomy, but not on text alone', () => {
    expect(stillRejected(base)).toBe(false);
    expect(stillRejected({ ...base, anatomy: true })).toBe(true);
    expect(stillRejected({ ...base, literalMedium: true })).toBe(true);
    expect(stillRejected({ ...base, multiFrame: true })).toBe(true);
    expect(stillRejected({ ...base, unwantedText: true })).toBe(false);
  });
});

describe('stillFlagLabels', () => {
  it('labels the set flags', () => {
    const v = stillVerdictSchema.parse({
      styleAdherence: 5,
      anatomy: true,
      unwantedText: true,
    });
    expect(stillFlagLabels(v)).toBe('ANATOMY,text');
  });
});
