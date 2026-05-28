import { describe, expect, it } from 'vitest';
import { shouldRecordUserEdit } from './user-edit-predicate';

describe('shouldRecordUserEdit', () => {
  it('returns false when userEditedPrompt is false (auto path)', () => {
    expect(
      shouldRecordUserEdit({
        userEditedPrompt: false,
        prompt: 'a fully assembled auto prompt',
        currentPrompt: 'something else',
      })
    ).toBe(false);
  });

  it('returns false when userEditedPrompt is undefined', () => {
    expect(
      shouldRecordUserEdit({
        userEditedPrompt: undefined,
        prompt: 'anything',
        currentPrompt: 'anything else',
      })
    ).toBe(false);
  });

  it('returns false when prompt is empty (no edit content to record)', () => {
    expect(
      shouldRecordUserEdit({
        userEditedPrompt: true,
        prompt: '',
        currentPrompt: 'cached prompt',
      })
    ).toBe(false);
  });

  it('returns false when prompt is undefined', () => {
    expect(
      shouldRecordUserEdit({
        userEditedPrompt: true,
        prompt: undefined,
        currentPrompt: 'cached prompt',
      })
    ).toBe(false);
  });

  it('returns false when prompt equals current cached prompt (no-op edit)', () => {
    expect(
      shouldRecordUserEdit({
        userEditedPrompt: true,
        prompt: 'identical prompt',
        currentPrompt: 'identical prompt',
      })
    ).toBe(false);
  });

  it('returns true when user edited and prompt differs from cached', () => {
    expect(
      shouldRecordUserEdit({
        userEditedPrompt: true,
        prompt: 'new edited prompt',
        currentPrompt: 'old cached prompt',
      })
    ).toBe(true);
  });

  it('returns true when current cached prompt is null (first user edit)', () => {
    expect(
      shouldRecordUserEdit({
        userEditedPrompt: true,
        prompt: 'first prompt',
        currentPrompt: null,
      })
    ).toBe(true);
  });

  it('treats whitespace-only difference as a real edit', () => {
    expect(
      shouldRecordUserEdit({
        userEditedPrompt: true,
        prompt: 'a prompt ',
        currentPrompt: 'a prompt',
      })
    ).toBe(true);
  });
});
