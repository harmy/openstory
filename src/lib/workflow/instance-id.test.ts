import { describe, expect, test } from 'vitest';
import {
  buildInstanceId,
  getEnvironmentSlug,
} from '@/lib/workflow/instance-id';

describe('getEnvironmentSlug', () => {
  test('returns "local" when VITE_APP_URL is unset', () => {
    expect(getEnvironmentSlug({})).toBe('local');
    expect(getEnvironmentSlug({ VITE_APP_URL: '' })).toBe('local');
  });

  test('slugifies a production hostname', () => {
    expect(getEnvironmentSlug({ VITE_APP_URL: 'https://openstory.so' })).toBe(
      'openstory-so'
    );
  });

  test('slugifies a PR-preview hostname so prod and preview do not collide', () => {
    const prod = getEnvironmentSlug({
      VITE_APP_URL: 'https://openstory.so',
    });
    const preview = getEnvironmentSlug({
      VITE_APP_URL: 'https://pr-123.openstory.dev',
    });
    expect(prod).not.toBe(preview);
    expect(preview).toBe('pr-123-openstory-dev');
  });

  test('falls back to "local" when VITE_APP_URL is not a valid URL', () => {
    expect(getEnvironmentSlug({ VITE_APP_URL: 'not a url' })).toBe('local');
  });
});

describe('buildInstanceId', () => {
  // CF enforces ^[a-zA-Z0-9_-]+$ on instance IDs — no colons or dots.
  const CF_VALID = /^[a-zA-Z0-9_-]+$/;

  test('composes envSlug + workflowName + suffix with underscore separators', () => {
    expect(
      buildInstanceId({
        env: { VITE_APP_URL: 'https://openstory.so' },
        workflowName: 'image',
        suffix: 'seq-123-frame-7',
      })
    ).toBe('openstory-so_image_seq-123-frame-7');
  });

  test('every generated ID matches CFs ^[a-zA-Z0-9_-]+$ rule', () => {
    const id = buildInstanceId({
      env: { VITE_APP_URL: 'https://pr-42.openstory.dev' },
      workflowName: 'analyze-script',
      suffix: '01KS23834FEGDBN8074VVPR3Q8:frame:7',
    });
    expect(id).toMatch(CF_VALID);
  });

  test('PR preview gets a distinct ID from production for the same suffix', () => {
    const prod = buildInstanceId({
      env: { VITE_APP_URL: 'https://openstory.so' },
      workflowName: 'image',
      suffix: 'seq-123-frame-7',
    });
    const preview = buildInstanceId({
      env: { VITE_APP_URL: 'https://pr-123.openstory.dev' },
      workflowName: 'image',
      suffix: 'seq-123-frame-7',
    });
    expect(prod).not.toBe(preview);
  });

  test('strips unsafe characters from the suffix (colons / spaces / asterisks)', () => {
    expect(
      buildInstanceId({
        env: { VITE_APP_URL: 'https://openstory.so' },
        workflowName: 'image',
        suffix: 'seq 123 / frame*7:variant.0',
      })
    ).toBe('openstory-so_image_seq-123-frame-7-variant-0');
  });

  test('truncates suffix to keep ID under 100 chars', () => {
    const id = buildInstanceId({
      env: { VITE_APP_URL: 'https://openstory.so' },
      workflowName: 'image',
      suffix: 'x'.repeat(200),
    });
    expect(id.length).toBeLessThanOrEqual(100);
    expect(id.startsWith('openstory-so_image_')).toBe(true);
  });

  test('throws when prefix alone exceeds the 100-char limit', () => {
    expect(() =>
      buildInstanceId({
        env: { VITE_APP_URL: `https://${'x'.repeat(120)}.example.com` },
        workflowName: 'image',
        suffix: 'frame-7',
      })
    ).toThrow(/exceeds the 100-char limit/);
  });
});
