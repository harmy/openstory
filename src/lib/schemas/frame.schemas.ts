import { z } from 'zod';
import { createInsertSchema, createUpdateSchema } from 'drizzle-orm/zod';
import { shots, FRAME_GENERATION_STATUSES } from '@/lib/db/schema/shots';
import { IMAGE_MODELS, IMAGE_TO_VIDEO_MODELS } from '@/lib/ai/models';
import { sceneSchema } from '@/lib/ai/scene-analysis.schema';

/**
 * Shared Zod schemas for frame operations
 * Generated from Drizzle schema with custom refinements
 *
 * Note: Frame metadata field should contain FrameMetadata structure (see src/lib/ai/frame.schema.ts)
 * which includes complete Scene data from script analysis. The schemas below validate structure
 * but do not enforce FrameMetadata typing to maintain flexibility.
 */

const createFrameSchema = createInsertSchema(shots, {
  description: (schema) => schema.min(1).max(5000),
  durationMs: (schema) => schema.min(1),
  metadata: () => sceneSchema.nullable().optional(),
  thumbnailStatus: () =>
    z.enum(FRAME_GENERATION_STATUSES).nullable().optional(),
  videoStatus: () => z.enum(FRAME_GENERATION_STATUSES).nullable().optional(),
  variantImageStatus: () =>
    z.enum(FRAME_GENERATION_STATUSES).nullable().optional(),
  audioStatus: () => z.enum(FRAME_GENERATION_STATUSES).nullable().optional(),
}).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});

export const updateFrameSchema = createUpdateSchema(shots, {
  description: (schema) => schema.min(1).max(5000),
  durationMs: (schema) => schema.min(1),
  metadata: () => sceneSchema.nullable().optional(),
  thumbnailStatus: () =>
    z.enum(FRAME_GENERATION_STATUSES).nullable().optional(),
  videoStatus: () => z.enum(FRAME_GENERATION_STATUSES).nullable().optional(),
  variantImageStatus: () =>
    z.enum(FRAME_GENERATION_STATUSES).nullable().optional(),
  audioStatus: () => z.enum(FRAME_GENERATION_STATUSES).nullable().optional(),
}).omit({
  id: true,
  sequenceId: true,
  createdAt: true,
  updatedAt: true,
});

export const regenerateFrameSchema = z.object({
  regenerateDescription: z.boolean().optional(),
  regenerateThumbnail: z.boolean().optional(),
  model: z
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Required for z.enum with dynamic keys
    .enum(Object.keys(IMAGE_MODELS) as [keyof typeof IMAGE_MODELS])
    .optional(),
  prompt: z.string().optional(),
});

export const generateMotionSchema = z.object({
  model: z
    .enum(
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Required for z.enum with dynamic keys
      Object.keys(IMAGE_TO_VIDEO_MODELS) as [keyof typeof IMAGE_TO_VIDEO_MODELS]
    )
    .optional(),
  prompt: z.string().optional(),
  duration: z.number().min(1).max(10).optional(),
  fps: z.number().min(7).max(30).optional(),
  motionBucket: z.number().min(1).max(255).optional(),
  /** Toggle sfx/dialogue/ambient audio for audio-capable models. */
  generateAudio: z.boolean().optional(),
});

export const generateVariantSchema = z.object({
  model: z
    // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Required for z.enum with dynamic keys
    .enum(Object.keys(IMAGE_MODELS) as [keyof typeof IMAGE_MODELS])
    .optional(),
  imageSize: z
    .enum(['square_hd', 'portrait_16_9', 'landscape_16_9'])
    .optional(),
  numImages: z.number().min(1).max(4).optional(),
  seed: z.number().int().optional(),
});

// Schemas for API endpoint frame creation (sequenceId comes from URL params)
export const singleFrameSchema = createFrameSchema.omit({ sequenceId: true });

export const bulkFrameSchema = z.object({
  frames: z.array(createFrameSchema.omit({ sequenceId: true })).min(1),
});

export type GenerateVariantInput = z.infer<typeof generateVariantSchema>;
