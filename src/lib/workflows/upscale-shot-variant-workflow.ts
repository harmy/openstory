import { IMAGE_MODELS } from '@/lib/ai/models';
import { ZERO_MICROS } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import {
  aspectRatioToImageSize,
  DEFAULT_IMAGE_SIZE,
} from '@/lib/constants/aspect-ratios';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { uploadImageToStorage } from '@/lib/image/image-storage';
import { buildReferenceImagePrompt } from '@/lib/prompts/reference-image-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  UpscaleShotVariantWorkflowInput,
  UpscaleShotVariantWorkflowResult,
} from '@/lib/workflow/types';
import { WorkflowValidationError } from '../workflow/errors';

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

export const upscaleShotVariantWorkflow = createScopedWorkflow<
  UpscaleShotVariantWorkflowInput,
  UpscaleShotVariantWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;

    const { sequenceId, teamId, frameId } = input;
    if (!sequenceId || !teamId || !frameId) {
      throw new WorkflowValidationError('sequenceId and teamId are required');
    }

    console.log(
      '[UpscaleShotVariantWorkflow]',
      `Starting upscale for frame ${frameId}`
    );

    const upscaleResult = await context.run('upscale-image', async () => {
      await getGenerationChannel(sequenceId).emit('generation.image:progress', {
        frameId: frameId,
        status: 'generating',
      });

      const frame = await scopedDb.frames.update(
        frameId,
        {
          thumbnailStatus: 'generating',
          thumbnailWorkflowRunId: context.workflowRunId,
        },
        { throwOnMissing: false }
      );

      if (!frame) {
        console.log(
          '[UpscaleShotVariantWorkflow]',
          `Frame ${frameId} was deleted, skipping workflow`
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

    await context.run('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: upscaleResult.cost,
        usedOwnKey: upscaleResult.usedOwnKey,
        description: 'Variant upscale (nano_banana_2)',
        metadata: { frameId: input.frameId, sequenceId: input.sequenceId },
        workflowName: 'UpscaleShotVariantWorkflow',
      });
    });

    const storageResult = await context.run('upload-to-storage', async () => {
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

    await context.run('update-frame', async () => {
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
        console.log(
          '[UpscaleShotVariantWorkflow]',
          `Frame ${input.frameId} was deleted, skipping final update`
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

      console.log(
        '[UpscaleShotVariantWorkflow]',
        `Upscale completed for frame ${input.frameId}`
      );
    });

    return {
      upscaledUrl: storageResult.url,
      upscaledPath: storageResult.path || '',
    } satisfies UpscaleShotVariantWorkflowResult;
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);

      console.error(
        '[UpscaleShotVariantWorkflow]',
        `Upscale failed for frame ${input.frameId}: ${error}`
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

      return `Upscale failed for frame ${input.frameId}`;
    },
  }
);
