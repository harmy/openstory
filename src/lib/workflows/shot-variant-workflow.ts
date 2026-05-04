import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '@/lib/ai/models';
import {
  deductWorkflowCredits,
  extractImageCost,
} from '@/lib/billing/workflow-deduction';
import {
  DEFAULT_IMAGE_SIZE,
  getVariantGridConfig,
} from '@/lib/constants/aspect-ratios';
import {
  generateImageWithProvider,
  type ImageGenerationParams,
} from '@/lib/image/image-generation';
import { uploadImageToStorage } from '@/lib/image/image-storage';
import {
  buildReferenceImagePrompt,
  type ReferenceImageDescription,
} from '@/lib/prompts/reference-image-prompt';
import { getVariantImagePrompt } from '@/lib/prompts/variant-image';
import { getGenerationChannel } from '@/lib/realtime';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  ShotVariantWorkflowInput,
  ShotVariantWorkflowResult,
} from '@/lib/workflow/types';

export const generateShotVariantWorkflow = createScopedWorkflow<
  ShotVariantWorkflowInput,
  ShotVariantWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;

    // Step 1: Set status to generating if frameId is provided
    const generationParams: ImageGenerationParams | null = await context.run(
      'set-generating-status',
      async () => {
        // Validate required fields
        if (!input.thumbnailUrl || input.thumbnailUrl.trim().length === 0) {
          throw new WorkflowValidationError(
            'Thumbnail URL is required for variant image generation'
          );
        }

        console.log(
          '[ShotVariantWorkflow]',
          `Starting variant image generation workflow for user ${input.userId}`
        );

        const model = input.model || DEFAULT_IMAGE_MODEL;
        const gridConfig = input.aspectRatio
          ? getVariantGridConfig(input.aspectRatio)
          : null;
        const imageSize =
          gridConfig?.imageSize ?? input.imageSize ?? DEFAULT_IMAGE_SIZE;

        if (input.frameId) {
          // update frame status to generating and store user prompt
          const frame = await scopedDb.frames.update(
            input.frameId,
            {
              variantImageStatus: 'generating',
              variantWorkflowRunId: context.workflowRunId,
            },
            { throwOnMissing: false }
          );

          if (!frame) {
            console.log(
              '[ShotVariantWorkflow]',
              `Frame ${input.frameId} was deleted, skipping workflow`
            );
            return null; // Signal to skip
          }

          // Dual-write: update shot variant status on frame_variants row (returns null if row doesn't exist)
          if (input.sequenceId) {
            await scopedDb.frameVariants.updateByFrameAndModel(
              input.frameId,
              'image',
              model,
              {
                shotVariantStatus: 'generating',
                shotVariantWorkflowRunId: context.workflowRunId,
              }
            );
          }

          // Emit realtime progress
          await getGenerationChannel(input.sequenceId).emit(
            'generation.variant-image:progress',
            {
              frameId: input.frameId,
              status: 'generating',
            }
          );
        }

        // Build prompt with scene context and grid layout
        const basePrompt = getVariantImagePrompt(
          imageSize,
          input.scenePrompt,
          gridConfig
            ? { cols: gridConfig.cols, rows: gridConfig.rows }
            : undefined
        );

        // ALL references go through buildReferenceImagePrompt so each URL is labeled in the prompt
        const allReferences: ReferenceImageDescription[] = [
          {
            referenceImageUrl: input.thumbnailUrl,
            description: `Primary source scene — generate ${gridConfig?.count ?? 9} variant shots from this image`,
            role: 'primary',
          },
          ...(input.characterReferences ?? []),
          ...(input.locationReferences ?? []),
          ...(input.elementReferences ?? []),
        ];

        const { prompt: enhancedPrompt, referenceUrls } =
          buildReferenceImagePrompt(
            basePrompt,
            allReferences,
            IMAGE_MODELS[model].maxPromptLength
          );

        // Return the generation params so it shows in the workflow context for debugging
        return {
          model,
          prompt: enhancedPrompt,
          imageSize,
          numImages: input.numImages ?? 1,
          seed: input.seed,
          referenceImageUrls: referenceUrls,
          traceName: 'variant-image',
        } satisfies ImageGenerationParams;
      }
    );

    // Early exit if frame was deleted
    if (!generationParams) {
      return { variantImageUrl: '' };
    }

    // Step 2: Generate image
    const imageResult = await context.run('generate-image', async () => {
      console.log(
        '[ShotVariantWorkflow]',
        `Generating variant image ${input.frameId} with model ${generationParams.model}`
      );

      return await generateImageWithProvider(generationParams, { scopedDb });
    });

    // Deduct credits for image generation (skip if team used own fal key)
    await context.run('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Variant image generation (${generationParams.model})`,
        metadata: {
          model: generationParams.model,
          frameId: input.frameId,
          sequenceId: input.sequenceId,
        },
        workflowName: 'ShotVariantWorkflow',
      });
    });

    let imageUrl: string = imageResult.imageUrls[0];

    if (input.frameId && input.sequenceId && input.teamId) {
      await context.run('upload-to-storage', async () => {
        if (
          !input.frameId ||
          !input.sequenceId ||
          !input.teamId ||
          !imageResult.imageUrls[0]
        ) {
          throw new Error('Missing required IDs for storage upload', {
            cause: JSON.stringify(imageResult),
          });
        }

        const result = await uploadImageToStorage({
          imageUrl: imageResult.imageUrls[0],
          teamId: input.teamId,
          sequenceId: input.sequenceId,
          frameId: input.frameId,
        });

        if (!result.url) {
          throw new Error('Failed to upload image to storage');
        }

        imageUrl = result.url;

        const updatedFrame = await scopedDb.frames.update(
          input.frameId,
          {
            variantImageUrl: result.url, // Store public URL (permanent, not signed)
            variantImageStatus: 'completed',
          },
          { throwOnMissing: false }
        );

        if (!updatedFrame) {
          console.log(
            '[ShotVariantWorkflow]',
            `Frame ${input.frameId} was deleted, skipping final update`
          );
          return { url: result.url, path: result.path };
        }

        // Dual-write: update shot variant on frame_variants row (returns null if row doesn't exist)
        const variantModel = input.model || DEFAULT_IMAGE_MODEL;
        await scopedDb.frameVariants.updateByFrameAndModel(
          input.frameId,
          'image',
          variantModel,
          {
            shotVariantUrl: result.url,
            shotVariantPath: result.path || null,
            shotVariantStatus: 'completed',
          }
        );

        // Emit completion progress
        await getGenerationChannel(input.sequenceId).emit(
          'generation.variant-image:progress',
          {
            frameId: input.frameId,
            status: 'completed',
            variantImageUrl: result.url,
          }
        );

        console.log(
          '[ShotVariantWorkflow]',
          `Image uploaded to storage: ${result.path}`
        );
        return { url: result.url, path: result.path };
      });
    }

    console.log('[ShotVariantWorkflow]', 'Image generation workflow completed');

    // Return workflow result
    const result: ShotVariantWorkflowResult = {
      variantImageUrl: imageUrl,
    };

    return result;
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);

      // Set frame variant status to 'failed' after all retries exhausted
      if (input.frameId && input.teamId) {
        await scopedDb.frames.update(
          input.frameId,
          {
            variantImageStatus: 'failed',
            variantImageError: error,
          },
          { throwOnMissing: false }
        );

        // Dual-write: update shot variant status on frame_variants row (returns null if row doesn't exist)
        const model = input.model || DEFAULT_IMAGE_MODEL;
        if (input.sequenceId) {
          await scopedDb.frameVariants.updateByFrameAndModel(
            input.frameId,
            'image',
            model,
            { shotVariantStatus: 'failed' }
          );
        }

        // Emit failure progress
        if (input.sequenceId) {
          try {
            await getGenerationChannel(input.sequenceId).emit(
              'generation.variant-image:progress',
              {
                frameId: input.frameId,
                status: 'failed',
              }
            );
          } catch {
            // Ignore emit errors
          }
        }

        console.error(
          '[ShotVariantWorkflow]',
          `Image generation failed for frame ${input.frameId}: ${error}`
        );
      }

      return `Image generation failed for frame ${input.frameId}`;
    },
  }
);
