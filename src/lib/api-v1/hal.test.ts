import { describe, expect, it } from 'vitest';
import { getLink, waitLink, withLinks } from './hal';

describe('hal helpers', () => {
  it('withLinks attaches a _links catalog without mutating the input', () => {
    const body = { id: 'seq_1', status: 'processing' };
    const linked = withLinks(body, {
      self: { href: '/api/v1/sequences/seq_1' },
    });
    expect(linked._links.self?.href).toBe('/api/v1/sequences/seq_1');
    expect('_links' in body).toBe(false);
  });

  it('getLink defaults to GET', () => {
    expect(getLink('/api/v1', 'root')).toEqual({
      href: '/api/v1',
      method: 'GET',
      title: 'root',
    });
  });

  it('waitLink advertises a templated ?wait variant', () => {
    const link = waitLink('/api/v1/sequences/seq_1');
    expect(link.href).toBe('/api/v1/sequences/seq_1{?wait}');
    expect(link.templated).toBe(true);
    expect(link.method).toBe('GET');
  });
});
