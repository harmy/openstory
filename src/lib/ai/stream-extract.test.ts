import { describe, expect, it } from 'vitest';
import { extractStreamingStringField } from './stream-extract';

describe('extractStreamingStringField', () => {
  it('returns empty when the field has not started streaming yet', () => {
    expect(extractStreamingStringField('{"vis', 'fullPrompt')).toBe('');
  });

  it('returns the in-progress value before the closing quote arrives', () => {
    const partial = '{"visual":{"fullPrompt":"a cinematic wide';
    expect(extractStreamingStringField(partial, 'fullPrompt')).toBe(
      'a cinematic wide'
    );
  });

  it('decodes escapes that complete inside the buffer', () => {
    // Backslash-quote inside the streamed prompt — the field hasn't closed yet,
    // so the trailing `\"` is content, not the terminator.
    const partial = '{"fullPrompt":"He said \\"go\\" and';
    expect(extractStreamingStringField(partial, 'fullPrompt')).toBe(
      'He said "go" and'
    );
  });

  it('terminates at the unescaped closing quote', () => {
    const complete = '{"fullPrompt":"final text","components":{"subject":"x"}}';
    expect(extractStreamingStringField(complete, 'fullPrompt')).toBe(
      'final text'
    );
  });

  it('halts at a mid-escape boundary without guessing', () => {
    // Stream cut off right after the backslash — emitting partial output here
    // would render a stray `\` to the user.
    const truncated = '{"fullPrompt":"line one\\';
    expect(extractStreamingStringField(truncated, 'fullPrompt')).toBe(
      'line one'
    );
  });

  it('handles a unicode escape that completes inside the buffer', () => {
    const partial = '{"fullPrompt":"caf\\u00e9 scene';
    expect(extractStreamingStringField(partial, 'fullPrompt')).toBe(
      'café scene'
    );
  });

  it('halts at a partial unicode escape (< 4 hex chars)', () => {
    const partial = '{"fullPrompt":"caf\\u00';
    expect(extractStreamingStringField(partial, 'fullPrompt')).toBe('caf');
  });
});
