import { describe, expect, it, vi } from 'vitest';

vi.doMock('content-collections', () => ({
  allDocs: [
    {
      slug: 'user-guide/creating-sequences',
      title: 'Creating Sequences',
      description: 'How to create sequences',
      section: 'User Guide',
      order: 1,
      body: '## Creating a New Sequence\n\nNavigate to Sequences.',
    },
  ],
}));

// Dynamic import so the mock applies; static imports are hoisted above
// vi.doMock and would bypass it.
const {
  DISCOVERY_LINK_HEADER,
  acceptsMarkdown,
  getMarkdownForPath,
  markdownResponse,
  withDiscoveryLinkHeader,
  withHtmlAccept,
} = await import('./discovery');

describe('DISCOVERY_LINK_HEADER', () => {
  it('advertises the llms.txt overview, human docs, and OpenAPI spec', () => {
    expect(DISCOVERY_LINK_HEADER).toContain('</llms.txt>; rel="describedby"');
    expect(DISCOVERY_LINK_HEADER).toContain(
      '</docs/llms.md>; rel="service-doc"'
    );
    // The machine-readable API description must be discoverable from any page.
    expect(DISCOVERY_LINK_HEADER).toContain(
      '</api/v1/openapi.json>; rel="service-desc"'
    );
  });
});

describe('acceptsMarkdown', () => {
  it('matches GET requests asking for text/markdown', () => {
    const request = new Request('https://example.com/', {
      headers: { accept: 'text/markdown' },
    });
    expect(acceptsMarkdown(request)).toBe(true);
  });

  it('matches markdown among multiple accept values', () => {
    const request = new Request('https://example.com/', {
      headers: { accept: 'text/markdown, text/html;q=0.8' },
    });
    expect(acceptsMarkdown(request)).toBe(true);
  });

  it('ignores plain HTML requests', () => {
    const request = new Request('https://example.com/', {
      headers: { accept: 'text/html,application/xhtml+xml' },
    });
    expect(acceptsMarkdown(request)).toBe(false);
  });

  it('ignores requests without an Accept header', () => {
    expect(acceptsMarkdown(new Request('https://example.com/'))).toBe(false);
  });

  it('ignores non-GET/HEAD methods', () => {
    const request = new Request('https://example.com/', {
      method: 'POST',
      headers: { accept: 'text/markdown' },
    });
    expect(acceptsMarkdown(request)).toBe(false);
  });
});

describe('getMarkdownForPath', () => {
  it('serves the llms.txt overview for the homepage', () => {
    const markdown = getMarkdownForPath('/');
    expect(markdown).toContain('# OpenStory');
    expect(markdown).toContain('## FAQ');
  });

  it('serves the FAQ rendition', () => {
    const markdown = getMarkdownForPath('/docs/faq');
    expect(markdown).toContain('# Frequently Asked Questions');
    expect(markdown).toContain('## What is OpenStory?');
  });

  it('serves docs pages from content-collections by slug', () => {
    const markdown = getMarkdownForPath('/docs/user-guide/creating-sequences');
    expect(markdown).toContain('# Creating Sequences');
    expect(markdown).toContain('Navigate to Sequences.');
  });

  it('tolerates trailing slashes', () => {
    expect(
      getMarkdownForPath('/docs/user-guide/creating-sequences/')
    ).not.toBeNull();
  });

  it('returns null for unknown docs slugs', () => {
    expect(getMarkdownForPath('/docs/nope')).toBeNull();
  });

  it('returns null for app routes', () => {
    expect(getMarkdownForPath('/sequences/new')).toBeNull();
  });
});

describe('markdownResponse', () => {
  it('returns text/markdown with token estimate and discovery links', async () => {
    const response = markdownResponse('# Hello world', 'GET');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe(
      'text/markdown; charset=utf-8'
    );
    expect(response.headers.get('x-markdown-tokens')).toBe('4');
    expect(response.headers.get('vary')).toBe('Accept');
    expect(response.headers.get('link')).toBe(DISCOVERY_LINK_HEADER);
    expect(await response.text()).toBe('# Hello world');
  });

  it('omits the body for HEAD requests', async () => {
    const response = markdownResponse('# Hello world', 'HEAD');
    expect(await response.text()).toBe('');
    expect(response.headers.get('x-markdown-tokens')).toBe('4');
  });
});

describe('withHtmlAccept', () => {
  it('replaces the Accept header with text/html', () => {
    const request = new Request('https://example.com/sequences/new', {
      headers: { accept: 'text/markdown', 'x-custom': 'kept' },
    });
    const normalized = withHtmlAccept(request);
    expect(normalized.headers.get('accept')).toBe('text/html');
    expect(normalized.headers.get('x-custom')).toBe('kept');
    expect(normalized.url).toBe(request.url);
  });
});

describe('withDiscoveryLinkHeader', () => {
  it('adds the Link header to HTML responses', () => {
    const response = new Response('<html></html>', {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
    const augmented = withDiscoveryLinkHeader(response, '/docs/faq');
    expect(augmented.headers.get('link')).toBe(DISCOVERY_LINK_HEADER);
  });

  it('adds the Link header to the homepage redirect', () => {
    const response = new Response(null, {
      status: 307,
      headers: { location: '/sequences/new' },
    });
    const augmented = withDiscoveryLinkHeader(response, '/');
    expect(augmented.headers.get('link')).toBe(DISCOVERY_LINK_HEADER);
    expect(augmented.status).toBe(307);
    expect(augmented.headers.get('location')).toBe('/sequences/new');
  });

  it('leaves non-document responses untouched', () => {
    const response = new Response('{}', {
      headers: { 'content-type': 'application/json' },
    });
    const augmented = withDiscoveryLinkHeader(response, '/api/test');
    expect(augmented.headers.get('link')).toBeNull();
    expect(augmented).toBe(response);
  });

  it('preserves an existing Link header', () => {
    const response = new Response('<html></html>', {
      headers: {
        'content-type': 'text/html',
        link: '</other>; rel="canonical"',
      },
    });
    const augmented = withDiscoveryLinkHeader(response, '/docs/faq');
    expect(augmented.headers.get('link')).toBe('</other>; rel="canonical"');
  });
});
