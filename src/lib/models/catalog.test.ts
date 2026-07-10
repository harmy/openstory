import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The catalog module holds a TTL response cache at module level, so each
 * test re-imports a fresh copy (vi.resetModules) with #env mocked — the
 * house doMock + dynamic-import pattern.
 *
 * MSW (src/test/setup.ts) wraps global fetch and forwards unhandled
 * requests to this stub as a single Request object, so helpers below
 * normalize both call shapes (`fetch(url, init)` and `fetch(request)`).
 */
const mockFetch = vi.fn<typeof fetch>();
vi.stubGlobal('fetch', mockFetch);

function urlOf(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function fetchedUrls(): string[] {
  return mockFetch.mock.calls.map((call) => urlOf(call[0]));
}

function fetchedHeaders(call: Parameters<typeof fetch>): Headers {
  const [input, init] = call;
  if (input instanceof Request) return input.headers;
  return new Headers(init?.headers);
}

let env: { MODELSCHEMAS_API_KEY?: string } = {};

async function importCatalog() {
  vi.resetModules();
  vi.doMock('#env', () => ({ getEnv: () => env }));
  return import('./catalog');
}

type ApiModelOverrides = {
  rawId?: string;
  activity?: string | null;
  displayName?: string;
  category?: string | null;
  deprecatedAt?: number | null;
};

function apiModel(overrides: ApiModelOverrides = {}) {
  const rawId = overrides.rawId ?? 'fal-ai/flux-1/dev';
  return {
    id: `fal-${rawId.replaceAll('/', '-')}`,
    provider: 'fal',
    rawId,
    activity: overrides.activity === undefined ? 'image' : overrides.activity,
    displayName: overrides.displayName ?? 'FLUX.1 [dev]',
    contextWindow: null,
    maxOutput: null,
    modalities: null,
    pricing: null,
    capabilities:
      overrides.category === null
        ? null
        : { category: overrides.category ?? 'text-to-image' },
    firstSeenAt: 1781210859,
    lastSeenAt: 1783721711,
    deprecatedAt: overrides.deprecatedAt ?? null,
  };
}

function jsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function modelsResponse(models: ReturnType<typeof apiModel>[]): Response {
  return jsonResponse({ count: models.length, models });
}

function schemaResponse(
  kind: 'input' | 'output',
  schema: object = { type: 'object', properties: {} }
): Response {
  return jsonResponse({
    provider: 'fal',
    activity: 'image',
    endpointId: 'fal-ai/flux-1/dev',
    kind,
    schema,
  });
}

beforeEach(() => {
  mockFetch.mockReset();
  env = {};
});

describe('listCatalogModels', () => {
  it('maps API models to CatalogModel', async () => {
    const { listCatalogModels } = await importCatalog();
    mockFetch.mockResolvedValueOnce(
      modelsResponse([
        apiModel({
          rawId: 'fal-ai/kling-video/v3/pro',
          activity: 'video',
          displayName: 'Kling v3 Pro',
          category: 'image-to-video',
        }),
      ])
    );

    const result = await listCatalogModels({ activity: 'video' });

    expect(result.models).toEqual([
      {
        endpointId: 'fal-ai/kling-video/v3/pro',
        displayName: 'Kling v3 Pro',
        activity: 'video',
        category: 'image-to-video',
      },
    ]);
    expect(result.nextCursor).toBeUndefined();
  });

  it('omits category when capabilities are null', async () => {
    const { listCatalogModels } = await importCatalog();
    mockFetch.mockResolvedValueOnce(
      modelsResponse([apiModel({ category: null })])
    );

    const { models } = await listCatalogModels();
    expect(models[0]?.category).toBeUndefined();
  });

  it('filters out chat, activity-less, and deprecated models', async () => {
    const { listCatalogModels } = await importCatalog();
    mockFetch.mockResolvedValueOnce(
      modelsResponse([
        apiModel({ rawId: 'fal-ai/keep-me' }),
        apiModel({ rawId: 'fal-ai/chatty', activity: 'chat' }),
        apiModel({ rawId: 'fal-ai/no-activity', activity: null }),
        apiModel({ rawId: 'fal-ai/gone', deprecatedAt: 1783721711 }),
      ])
    );

    const { models } = await listCatalogModels();
    expect(models.map((m) => m.endpointId)).toEqual(['fal-ai/keep-me']);
  });

  it('paginates locally with numeric-offset cursors', async () => {
    const { listCatalogModels } = await importCatalog();
    const all = Array.from({ length: 5 }, (_, i) =>
      apiModel({ rawId: `fal-ai/model-${i}` })
    );
    mockFetch.mockResolvedValue(modelsResponse(all));

    const page1 = await listCatalogModels({ limit: 2 });
    expect(page1.models.map((m) => m.endpointId)).toEqual([
      'fal-ai/model-0',
      'fal-ai/model-1',
    ]);
    expect(page1.nextCursor).toBe('2');

    const page2 = await listCatalogModels({ limit: 2, cursor: '2' });
    expect(page2.models.map((m) => m.endpointId)).toEqual([
      'fal-ai/model-2',
      'fal-ai/model-3',
    ]);
    expect(page2.nextCursor).toBe('4');

    const page3 = await listCatalogModels({ limit: 2, cursor: '4' });
    expect(page3.models.map((m) => m.endpointId)).toEqual(['fal-ai/model-4']);
    expect(page3.nextCursor).toBeUndefined();
  });

  it('treats an invalid cursor as the first page', async () => {
    const { listCatalogModels } = await importCatalog();
    mockFetch.mockResolvedValueOnce(modelsResponse([apiModel()]));

    const { models } = await listCatalogModels({ cursor: 'garbage' });
    expect(models).toHaveLength(1);
  });

  it('passes provider, activity, and q upstream, unauthenticated by default', async () => {
    const { listCatalogModels } = await importCatalog();
    mockFetch.mockResolvedValueOnce(modelsResponse([]));

    await listCatalogModels({ activity: 'image', q: 'flux' });

    expect(fetchedUrls()).toEqual([
      'https://modelschemas.com/v1/models?provider=fal&activity=image&q=flux',
    ]);
    const call = mockFetch.mock.calls[0];
    expect(call && fetchedHeaders(call).get('authorization')).toBeNull();
  });

  it('sends Authorization when MODELSCHEMAS_API_KEY is set', async () => {
    env = { MODELSCHEMAS_API_KEY: 'ms-test-key' };
    const { listCatalogModels } = await importCatalog();
    mockFetch.mockResolvedValueOnce(modelsResponse([]));

    await listCatalogModels();

    const call = mockFetch.mock.calls[0];
    expect(call && fetchedHeaders(call).get('authorization')).toBe(
      'Bearer ms-test-key'
    );
  });

  it('serves repeat requests from the TTL cache', async () => {
    const { listCatalogModels } = await importCatalog();
    mockFetch.mockResolvedValueOnce(modelsResponse([apiModel()]));

    await listCatalogModels({ limit: 1 });
    const again = await listCatalogModels({ limit: 1 });

    expect(again.models).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('throws CatalogApiError with the upstream code and message', async () => {
    const { listCatalogModels, CatalogApiError } = await importCatalog();
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        { error: { code: 'rate_limited', message: 'Too many requests' } },
        429
      )
    );

    const promise = listCatalogModels();
    await expect(promise).rejects.toBeInstanceOf(CatalogApiError);
    await expect(promise).rejects.toMatchObject({
      status: 429,
      code: 'rate_limited',
      message: 'Too many requests',
    });
  });

  it('throws a status-based CatalogApiError on a non-JSON error body', async () => {
    const { listCatalogModels } = await importCatalog();
    mockFetch.mockResolvedValueOnce(new Response('gateway荒', { status: 502 }));

    await expect(listCatalogModels()).rejects.toMatchObject({
      status: 502,
      message: 'modelschemas request failed (502)',
    });
  });
});

describe('getModelDetail', () => {
  function mockDetailFetches({
    output = schemaResponse('output'),
    metadataModels = [
      apiModel(),
      apiModel({
        rawId: 'fal-ai/flux-1/dev/redux',
        displayName: 'FLUX.1 [dev] Redux',
      }),
    ],
  }: {
    output?: Response;
    metadataModels?: ReturnType<typeof apiModel>[];
  } = {}) {
    mockFetch.mockImplementation((input) => {
      const url = urlOf(input);
      if (url.includes('kind=input')) {
        return Promise.resolve(
          schemaResponse('input', {
            type: 'object',
            properties: { prompt: { type: 'string' } },
            required: ['prompt'],
            'x-fal-order-properties': ['prompt'],
          })
        );
      }
      if (url.includes('kind=output')) return Promise.resolve(output);
      return Promise.resolve(modelsResponse(metadataModels));
    });
  }

  it('returns metadata + input and output schemas', async () => {
    const { getModelDetail } = await importCatalog();
    mockDetailFetches();

    const detail = await getModelDetail('fal-ai/flux-1/dev', 'image');

    expect(detail.model).toEqual({
      endpointId: 'fal-ai/flux-1/dev',
      displayName: 'FLUX.1 [dev]',
      activity: 'image',
      category: 'text-to-image',
    });
    expect(detail.inputSchema).toMatchObject({
      required: ['prompt'],
      'x-fal-order-properties': ['prompt'],
    });
    expect(detail.outputSchema).toMatchObject({ type: 'object' });

    // Endpoint slashes stay literal in the schema path.
    expect(fetchedUrls()).toContain(
      'https://modelschemas.com/v1/schemas/fal/image/fal-ai/flux-1/dev?kind=input'
    );
  });

  it('returns null output schema when the endpoint has none', async () => {
    const { getModelDetail } = await importCatalog();
    mockDetailFetches({
      output: jsonResponse({ error: { code: 'unknown_schema' } }, 404),
    });

    const detail = await getModelDetail('fal-ai/flux-1/dev', 'image');
    expect(detail.outputSchema).toBeNull();
  });

  it('throws a 404 CatalogApiError when the input schema is missing', async () => {
    const { getModelDetail, CatalogApiError } = await importCatalog();
    mockFetch.mockImplementation((input) => {
      const url = urlOf(input);
      if (url.includes('/v1/schemas/')) {
        return Promise.resolve(
          jsonResponse(
            { error: { code: 'unknown_schema', message: 'No schema' } },
            404
          )
        );
      }
      return Promise.resolve(modelsResponse([]));
    });

    const promise = getModelDetail('fal-ai/does-not-exist', 'image');
    await expect(promise).rejects.toBeInstanceOf(CatalogApiError);
    await expect(promise).rejects.toMatchObject({
      status: 404,
      code: 'unknown_schema',
    });
  });

  it('falls back to the endpoint id when no exact catalog row matches', async () => {
    const { getModelDetail } = await importCatalog();
    // `q` is a substring match — only a longer sibling comes back.
    mockDetailFetches({
      metadataModels: [apiModel({ rawId: 'fal-ai/flux-1/dev/redux' })],
    });

    const detail = await getModelDetail('fal-ai/flux-1/dev', 'image');
    expect(detail.model).toEqual({
      endpointId: 'fal-ai/flux-1/dev',
      displayName: 'fal-ai/flux-1/dev',
      activity: 'image',
    });
  });
});
