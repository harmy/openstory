import { characterBibleEntrySchema } from '@/lib/ai/scene-analysis.schema';
import { talent, talentMedia, talentSheets } from '@/lib/db/schema';
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
    referenceImageUrls: z.array(z.string().url()).optional(),
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

export const updateTalentSheetSchema = createUpdateSchema(talentSheets, {
  metadata: () => characterBibleEntrySchema.nullish(),
}).omit({
  id: true,
  talentId: true,
  createdAt: true,
  updatedAt: true,
});

// Talent media schemas
export const createTalentMediaSchema = createInsertSchema(talentMedia, {
  url: z.string().url(),
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
export type CreateTalentSheetInput = z.infer<typeof createTalentSheetSchema>;
export type UpdateTalentSheetInput = z.infer<typeof updateTalentSheetSchema>;
export type CreateTalentMediaInput = z.infer<typeof createTalentMediaSchema>;
export type ListTalentFilter = z.infer<typeof listTalentFilterSchema>;
