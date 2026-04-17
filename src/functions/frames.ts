import type { NewFrame } from '@/lib/db/schema';
import { getVideoDownloadUrl } from '@/lib/motion/video-storage';
import {
  bulkFrameSchema,
  singleFrameSchema,
  updateFrameSchema,
} from '@/lib/schemas/frame.schemas';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { reconcileStaleFrameStatuses } from '@/lib/workflow/reconcile';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { frameAccessMiddleware, sequenceAccessMiddleware } from './middleware';

const frameIdInputSchema = z.object({
  sequenceId: ulidSchema,
  frameId: ulidSchema,
});

export const getFramesFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const frames = await context.scopedDb.frames.listBySequence(
      context.sequence.id
    );

    // Fire-and-forget: reconcile stale statuses in background
    reconcileStaleFrameStatuses(frames, context.scopedDb.frames).catch(
      console.error
    );

    return frames;
  });

export const getFrameFn = createServerFn({ method: 'GET' })
  .middleware([frameAccessMiddleware])
  .handler(async ({ context }) => {
    return context.frame;
  });

export const getSequenceImageModelsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.frameVariants.listModelsForSequence(
      context.sequence.id,
      'image'
    );
  });

export const getSequenceImageVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.frameVariants.listBySequence(
      context.sequence.id,
      'image'
    );
  });

export const createFrameFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(singleFrameSchema.extend({ sequenceId: ulidSchema }))
  )
  .handler(async ({ data, context }) => {
    return context.scopedDb.frames.create(data);
  });

export const createFramesBulkFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        frames: bulkFrameSchema.shape.frames,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const frameInserts: NewFrame[] = data.frames.map((frame) => ({
      sequenceId: data.sequenceId,
      ...frame,
    }));
    return context.scopedDb.frames.bulkUpsert(frameInserts);
  });

export const updateFrameFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(
    zodValidator(
      updateFrameSchema.extend({ sequenceId: ulidSchema, frameId: ulidSchema })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequenceId: _, frameId, ...updateData } = data;
    return context.scopedDb.frames.update(frameId, updateData);
  });

export const deleteFrameFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameIdInputSchema))
  .handler(async ({ data, context }) => {
    await context.scopedDb.frames.delete(data.frameId);
    return { success: true, sequenceId: data.sequenceId };
  });

export const deleteFramesBySequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    await context.scopedDb.frames.deleteBySequence(context.sequence.id);
    return { success: true };
  });

export const reorderFramesFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        frameOrders: z
          .array(z.object({ id: ulidSchema, orderIndex: z.number().int() }))
          .min(1),
      })
    )
  )
  .handler(async ({ data, context }) => {
    const frameOrders = data.frameOrders.map((f) => ({
      id: f.id,
      order_index: f.orderIndex,
    }));
    await context.scopedDb.frames.reorder(data.sequenceId, frameOrders);
    return { success: true };
  });

/**
 * Get a signed download URL for a frame's video.
 * Uses Content-Disposition: attachment to force browser download.
 */
export const getFrameDownloadUrlFn = createServerFn({ method: 'GET' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameIdInputSchema))
  .handler(async ({ context }) => {
    const { frame } = context;

    if (!frame.videoPath) {
      throw new Error('Frame does not have a video');
    }

    const filename =
      frame.videoPath.split('/').pop() || `scene-${frame.id}_openstory.mp4`;

    const downloadUrl = await getVideoDownloadUrl(
      frame.videoPath,
      filename,
      3600
    );

    return { downloadUrl, filename };
  });
