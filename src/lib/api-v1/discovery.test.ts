import { describe, expect, it } from 'vitest';
import { buildRootDocument, createSequenceLink } from './discovery';
import { apiCreateSequenceSchema } from './input-schema';

describe('buildRootDocument', () => {
  it('reads like MCP-style instructions and self-describes the API', () => {
    const doc = buildRootDocument();
    expect(doc.name).toBe('OpenStory API');
    expect(doc.version).toBe('v1');
    // Narrative covers the create→poll workflow, auth, and conventions.
    expect(doc.instructions).toMatch(/POST \/api\/v1\/sequences/);
    expect(doc.instructions).toMatch(/Authorization: Bearer/);
    expect(doc.instructions).toMatch(/\?wait=/);
    expect(doc.instructions).toMatch(/_links/);
  });

  it('embeds the request JSON Schema for tool callers', () => {
    const doc = buildRootDocument();
    expect(doc.requestSchema).toMatchObject({ type: 'object' });
  });

  it('links every operation with a method (and write links with examples)', () => {
    const { _links } = buildRootDocument();
    expect(_links.self?.method).toBe('GET');
    expect(_links['sequence-status']?.templated).toBe(true);

    const create = _links['create-sequence'];
    expect(create?.method).toBe('POST');
    expect(create?.contentType).toBe('application/json');
    expect(create?.examples).toHaveLength(1);
  });
});

describe('createSequenceLink', () => {
  it('carries an example body that satisfies the input schema', () => {
    const [example] = createSequenceLink().examples ?? [];
    // The advertised example must actually be a valid request.
    expect(() => apiCreateSequenceSchema.parse(example)).not.toThrow();
  });
});
