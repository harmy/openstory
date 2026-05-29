/**
 * Cloudflare Workflows port of `upscaleShotVariantWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/upscale-shot-variant-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`.
 */

import { IMAGE_MODELS } from '@/lib/ai/models';
import { ZERO_MICROS } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import {
  aspectRatioToImageSize,
  DEFAULT_IMAGE_SIZE,
} from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { uploadImageToStorage } from '@/lib/image/image-storage';
import { buildReferenceImagePrompt } from '@/lib/prompts/reference-image-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  UpscaleShotVariantWorkflowInput,
  UpscaleShotVariantWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'upscale-shot-variant']);

const UPSCALE_PROMPT = `Upscale this image to a clean, high-resolution frame suitable for animation.

RENDERING RULES
- Keep the original scene, pose, framing and camera angle IDENTICAL.
- Preserve the identity of all real people:
  - Do NOT change their faces, expressions, hairstyles, or clothing.
  - Do NOT add new people or remove existing people.
- Faces:
  - Make faces sharp and detailed.
  - Clear eyes, natural skin texture, no plastic or over-smoothed look.
- Text & logos:
  - Preserve all printed text, signage, and logos exactly as they appear.
  - Re-render text cleanly at higher resolution.
  - Do NOT invent new words, change names, or move signs.
- Style:
  - Realistic photographic look.
  - Keep original colours, lighting and depth of field.
  - No extra filters, bokeh, vignettes, film grain, or stylistic changes unless they already exist.

OUTPUT
- A SINGLE high-resolution image.
- Aspect ratio: match the original exactly.
- Resolution: upscale to animation-ready quality.
- No text overlays, borders, watermarks, or new graphics added by the model.`;

export class UpscaleShotVariantWorkflow extends OpenStoryWorkflowEntrypoint<UpscaleShotVariantWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<UpscaleShotVariantWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<UpscaleShotVariantWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;

    const { sequenceId, teamId, frameId } = input;
    if (!sequenceId || !teamId || !frameId) {
      throw new WorkflowValidationError('sequenceId and teamId are required');
    }

    logger.info(
      `[UpscaleShotVariantWorkflow:cf] Starting upscale for frame ${frameId}`
    );

    const upscaleResult = await step.do('upscale-image', async () => {
      await getGenerationChannel(sequenceId).emit('generation.image:progress', {
        frameId: frameId,
        status: 'generating',
      });

      const frame = await scopedDb.frames.update(
        frameId,
        {
          thumbnailStatus: 'generating',
          thumbnailWorkflowRunId: workflowRunId,
        },
        { throwOnMissing: false }
      );

      if (!frame) {
        logger.info(
          `[UpscaleShotVariantWorkflow:cf] Frame ${frameId} was deleted, skipping workflow`
        );
        return null;
      }

      // Build enhanced prompt with character/location references (ensure roles are set)
      const allReferences = [
        ...(input.characterReferences ?? []).map((r) => ({
          ...r,
          role: r.role ?? ('character' as const),
        })),
        ...(input.locationReferences ?? []).map((r) => ({
          ...r,
          role: r.role ?? ('location' as const),
        })),
      ];
      const { prompt: enhancedPrompt, referenceUrls: charLocUrls } =
        buildReferenceImagePrompt(
          UPSCALE_PROMPT,
          allReferences,
          IMAGE_MODELS.nano_banana_2.maxPromptLength
        );

      // Determine output image size from sequence aspect ratio
      const imageSize = input.aspectRatio
        ? aspectRatioToImageSize(input.aspectRatio)
        : DEFAULT_IMAGE_SIZE;

      // Cropped tile is primary source (first), char/loc refs appended after
      const result = await generateImageWithProvider(
        {
          model: 'nano_banana_2',
          prompt: enhancedPrompt,
          imageSize,
          referenceImageUrls: [input.croppedTileUrl, ...charLocUrls],
          numImages: 1,
          outputFormat: 'png',
        },
        { scopedDb }
      );
      return {
        imageUrl: result.imageUrls[0],
        cost: result.metadata.cost ?? ZERO_MICROS,
        usedOwnKey: result.metadata.usedOwnKey,
      };
    });

    if (!upscaleResult) {
      return { upscaledUrl: '', upscaledPath: '' };
    }

    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: upscaleResult.cost,
        usedOwnKey: upscaleResult.usedOwnKey,
        description: 'Variant upscale (nano_banana_2)',
        metadata: { frameId: input.frameId, sequenceId: input.sequenceId },
        workflowName: 'UpscaleShotVariantWorkflow',
      });
    });

    const storageResult = await step.do('upload-to-storage', async () => {
      if (!upscaleResult.imageUrl) {
        throw new Error('Upscale did not return an image URL');
      }
      const result = await uploadImageToStorage({
        imageUrl: upscaleResult.imageUrl,
        teamId: teamId,
        sequenceId: sequenceId,
        frameId: input.frameId,
      });

      if (!result.url) {
        throw new Error('Failed to upload upscaled image to storage');
      }

      return { url: result.url, path: result.path };
    });

    await step.do('update-frame', async () => {
      const updatedFrame = await scopedDb.frames.update(
        input.frameId,
        {
          thumbnailUrl: storageResult.url,
          thumbnailPath: storageResult.path || null,
          thumbnailStatus: 'completed',
          thumbnailGeneratedAt: new Date(),
        },
        { throwOnMissing: false }
      );

      if (!updatedFrame) {
        logger.info(
          `[UpscaleShotVariantWorkflow:cf] Frame ${input.frameId} was deleted, skipping final update`
        );
        return;
      }

      await getGenerationChannel(input.sequenceId).emit(
        'generation.image:progress',
        {
          frameId: input.frameId,
          status: 'completed',
          thumbnailUrl: storageResult.url,
        }
      );

      logger.info(
        `[UpscaleShotVariantWorkflow:cf] Upscale completed for frame ${input.frameId}`
      );
    });

    return {
      upscaledUrl: storageResult.url,
      upscaledPath: storageResult.path || '',
    } satisfies UpscaleShotVariantWorkflowResult;
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<UpscaleShotVariantWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;

    logger.error(
      `[UpscaleShotVariantWorkflow:cf] Upscale failed for frame ${input.frameId}: ${error}`
    );

    if (input.frameId && input.teamId) {
      await scopedDb.frames.update(
        input.frameId,
        {
          thumbnailStatus: 'completed',
          thumbnailGeneratedAt: new Date(),
        },
        { throwOnMissing: false }
      );

      await getGenerationChannel(input.sequenceId).emit(
        'generation.image:progress',
        { frameId: input.frameId, status: 'completed' }
      );
    }
  }
}
