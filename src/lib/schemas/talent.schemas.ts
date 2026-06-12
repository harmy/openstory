import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import { characterBibleEntrySchema } from '@/lib/ai/scene-analysis.schema';
import { talent, talentSheets } from '@/lib/db/schema';
import { createInsertSchema, createUpdateSchema } from 'drizzle-orm/zod';
import { z } from 'zod';

/**
 * Shared Zod schemas for talent library operations
 */

// Talent schemas
export const createTalentSchema = createInsertSchema(talent, {
  name: z.string().min(1).max(255),
  description: z.string().optional(),
})
  .omit({
    id: true,
    teamId: true,
    createdBy: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    referenceImageUrls: z.array(mediaUrlSchema).optional(),
  });

export const updateTalentSchema = createUpdateSchema(talent).omit({
  id: true,
  teamId: true,
  createdBy: true,
  createdAt: true,
  updatedAt: true,
});

// Talent sheet schemas
export const createTalentSheetSchema = createInsertSchema(talentSheets, {
  name: z.string().min(1).max(255),
  metadata: () => characterBibleEntrySchema.nullish(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

// Filter schemas
export const listTalentFilterSchema = z.object({
  favoritesOnly: z.boolean().optional(),
});

export type CreateTalentInput = z.infer<typeof createTalentSchema>;
export type UpdateTalentInput = z.infer<typeof updateTalentSchema>;
