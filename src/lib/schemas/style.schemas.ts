import {
  styles,
  StyleConfigSchema,
  StyleSampleVideoSchema,
} from '@/lib/db/schema';
import { createInsertSchema, createUpdateSchema } from 'drizzle-orm/zod';
import { z } from 'zod';

/**
 * Shared Zod schemas for style operations
 */

const tagsSchema = z.array(z.string()).nullish();
const useCasesSchema = z.array(z.string()).nullish();
const sampleVideosSchema = z.array(StyleSampleVideoSchema).nullish();

// Columns the client must never set. usageCount is server-managed (popularity
// ranking), id/teamId/createdBy/createdAt/updatedAt are injected by the scoped
// layer, and isTemplate/version/sortOrder are admin/migration-only.
const SERVER_MANAGED_COLUMNS = {
  id: true,
  teamId: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
  usageCount: true,
  version: true,
  isTemplate: true,
  sortOrder: true,
} as const;

export const createStyleSchema = createInsertSchema(styles, {
  config: () => StyleConfigSchema,
  tags: () => tagsSchema,
  useCases: () => useCasesSchema,
  sampleVideos: () => sampleVideosSchema,
}).omit(SERVER_MANAGED_COLUMNS);
export const updateStyleSchema = createUpdateSchema(styles, {
  config: () => StyleConfigSchema.optional(),
  tags: () => tagsSchema,
  useCases: () => useCasesSchema,
  sampleVideos: () => sampleVideosSchema,
}).omit(SERVER_MANAGED_COLUMNS);
