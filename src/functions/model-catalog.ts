/**
 * Model Catalog Server Functions (#458)
 *
 * Thin server-side wrappers around the modelschemas catalog client
 * (src/lib/models/catalog.ts). No auth middleware: the catalog is public
 * data and the app shell is anonymous-browsable (same policy as
 * getPublicStylesFn) — running a model is what's gated, not browsing.
 */
import { assertModelsEnabled } from '@/lib/flags';
import {
  CATALOG_ACTIVITIES,
  getModelDetail,
  listCatalogModels,
} from '@/lib/models/catalog';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';

const listCatalogModelsInputSchema = z.object({
  activity: z.enum(CATALOG_ACTIVITIES).optional(),
  q: z.string().trim().max(200).optional(),
  cursor: z.string().max(20).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

/**
 * List fal models from the live modelschemas catalog.
 * @returns `{ models, nextCursor? }` — pass `nextCursor` back for more.
 */
export const listCatalogModelsFn = createServerFn({ method: 'GET' })
  .inputValidator(zodValidator(listCatalogModelsInputSchema.optional()))
  .handler(async ({ data }) => {
    assertModelsEnabled();
    return listCatalogModels(data ?? {});
  });

const getModelDetailInputSchema = z.object({
  /** fal endpoint id, e.g. `fal-ai/flux-1/dev`. */
  endpointId: z.string().trim().min(1).max(200),
  activity: z.enum(CATALOG_ACTIVITIES),
});

/**
 * Model metadata + input JSON Schema (+ output schema when published).
 * @returns `{ model, inputSchema, outputSchema }`
 */
export const getModelDetailFn = createServerFn({ method: 'GET' })
  .inputValidator(zodValidator(getModelDetailInputSchema))
  .handler(async ({ data }) => {
    assertModelsEnabled();
    return getModelDetail(data.endpointId, data.activity);
  });
