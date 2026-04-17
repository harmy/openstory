import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '@/lib/ai/models';
import { ZERO_MICROS, microsToUsd } from '@/lib/billing/money';
import { DEFAULT_IMAGE_SIZE } from '@/lib/constants/aspect-ratios';
import {
  generateImageWithProvider,
  type ImageGenerationParams,
} from '@/lib/image/image-generation';
import { uploadImageToStorage } from '@/lib/image/image-storage';
import { buildReferenceImagePrompt } from '@/lib/prompts/reference-image-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { simpleHash } from '@/lib/utils/hash';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { ImageWorkflowInput } from '@/lib/workflow/types';

type ImageWorkflowResult = {
  imageUrl: string;
  frameId?: string;
  sequenceId?: string;
};

export const generateImageWorkflow = createScopedWorkflow<
  ImageWorkflowInput,
  ImageWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;

    const generationParams = await context.run(
      'set-generating-status',
      async (): Promise<ImageGenerationParams | null> => {
        if (!input.prompt.trim()) {
          throw new WorkflowValidationError(
            'Prompt is required for image generation'
          );
        }

        console.log(
          '[ImageWorkflow]',
          `Starting image generation for user ${input.userId}`
        );

        const model = input.model ?? DEFAULT_IMAGE_MODEL;

        if (input.frameId) {
          const frame = await scopedDb.frames.update(
            input.frameId,
            {
              thumbnailStatus: 'generating',
              thumbnailWorkflowRunId: context.workflowRunId,
              imageModel: model,
              imagePrompt: input.prompt,
            },
            { throwOnMissing: false }
          );

          if (!frame) {
            console.log(
              '[ImageWorkflow]',
              `Frame ${input.frameId} was deleted, skipping`
            );
            return null;
          }

          // Dual-write: upsert frame_variants row
          if (input.sequenceId) {
            await scopedDb.frameVariants.upsert({
              frameId: input.frameId,
              sequenceId: input.sequenceId,
              variantType: 'image',
              model,
              status: 'generating',
              workflowRunId: context.workflowRunId,
            });
          }

          await getGenerationChannel(input.sequenceId).emit(
            'generation.image:progress',
            { frameId: input.frameId, status: 'generating', model }
          );
        }

        return {
          model,
          prompt: buildReferenceImagePrompt(
            input.prompt,
            input.referenceImages ?? [],
            IMAGE_MODELS[model].maxPromptLength
          ).prompt,
          imageSize: input.imageSize ?? DEFAULT_IMAGE_SIZE,
          numImages: input.numImages ?? 1,
          seed: input.seed,
          referenceImageUrls:
            input.referenceImages?.map((ref) => ref.referenceImageUrl) ?? [],
          traceName: 'frame-image',
        } satisfies ImageGenerationParams;
      }
    );

    if (!generationParams) {
      return {
        imageUrl: '',
        frameId: input.frameId,
        sequenceId: input.sequenceId,
      } satisfies ImageWorkflowResult;
    }

    const imageResult = await context.run('generate-image', async () => {
      console.log(
        '[ImageWorkflow]',
        `Generating image ${input.frameId} with model ${generationParams.model}`
      );
      return generateImageWithProvider(generationParams, { scopedDb });
    });

    const imageCostMicros = imageResult.metadata.cost ?? ZERO_MICROS;
    const { teamId, frameId, sequenceId } = input;
    if (imageCostMicros > 0 && teamId && !imageResult.metadata.usedOwnKey) {
      await context.run('deduct-credits', async () => {
        if (!(await scopedDb.billing.hasEnoughCredits(imageCostMicros))) {
          console.warn(
            `[ImageWorkflow] Insufficient credits for team ${teamId} (cost: $${microsToUsd(imageCostMicros).toFixed(4)}), skipping deduction`
          );
          return;
        }
        await scopedDb.billing.deductCredits(imageCostMicros, {
          description: `Image generation (${generationParams.model})`,
          metadata: {
            model: generationParams.model,
            frameId: input.frameId,
            sequenceId: input.sequenceId,
          },
        });
      });
    }

    let imageUrl: string = imageResult.imageUrls[0];

    if (imageUrl && frameId && sequenceId && teamId && !input.skipStorage) {
      const storageUrl = await context.run('upload-to-storage', async () => {
        const result = await uploadImageToStorage({
          imageUrl,
          teamId,
          sequenceId,
          frameId,
        });

        if (!result.url) {
          throw new Error('Failed to upload image to storage');
        }

        const updatedFrame = await scopedDb.frames.update(
          frameId,
          {
            thumbnailPath: result.path || null,
            thumbnailUrl: result.url,
            thumbnailStatus: 'completed',
            thumbnailGeneratedAt: new Date(),
            thumbnailError: null,
            videoUrl: null,
            videoPath: null,
            videoStatus: 'pending',
            videoWorkflowRunId: null,
            videoGeneratedAt: null,
            videoError: null,
          },
          { throwOnMissing: false }
        );

        if (!updatedFrame) {
          console.log(
            '[ImageWorkflow]',
            `Frame ${frameId} was deleted, skipping final update`
          );
          return;
        }

        // Dual-write: update frame_variants row (returns null if row doesn't exist)
        await scopedDb.frameVariants.updateByFrameAndModel(
          frameId,
          'image',
          generationParams.model,
          {
            url: result.url,
            storagePath: result.path || null,
            status: 'completed',
            generatedAt: new Date(),
            error: null,
            promptHash: input.prompt ? simpleHash(input.prompt) : null,
          }
        );

        await getGenerationChannel(sequenceId).emit(
          'generation.image:progress',
          {
            frameId,
            status: 'completed',
            thumbnailUrl: result.url,
            model: generationParams.model,
          }
        );

        console.log('[ImageWorkflow]', `Uploaded to storage: ${result.path}`);

        return result.url;
      });
      if (storageUrl) imageUrl = storageUrl;
    } else if (imageUrl && frameId && input.skipStorage) {
      // Preview mode: store fal.ai CDN URL in dedicated preview field
      await context.run('store-preview-url', async () => {
        const updatedFrame = await scopedDb.frames.update(
          frameId,
          {
            previewThumbnailUrl: imageUrl,
            thumbnailGeneratedAt: new Date(),
            thumbnailError: null,
          },
          { throwOnMissing: false }
        );

        if (!updatedFrame) {
          console.log(
            '[ImageWorkflow]',
            `Frame ${frameId} was deleted, skipping preview update`
          );
          return;
        }

        if (sequenceId) {
          await getGenerationChannel(sequenceId).emit(
            'generation.image:progress',
            { frameId, previewThumbnailUrl: imageUrl }
          );
        }
      });
    }

    console.log('[ImageWorkflow]', 'Image generation workflow completed');

    return { imageUrl, frameId, sequenceId };
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const input = context.requestPayload;
      // Skipping storage means we're in preview mode
      const previewMode = input.skipStorage;
      if (!previewMode) {
        // Only flag the frame as failed if we're not in preview mode
        const error = sanitizeFailResponse(failResponse);

        if (input.frameId && input.teamId) {
          await scopedDb.frames.update(
            input.frameId,
            { thumbnailStatus: 'failed', thumbnailError: error },
            { throwOnMissing: false }
          );

          // Dual-write: update frame_variants row (returns null if row doesn't exist)
          const model = input.model ?? DEFAULT_IMAGE_MODEL;
          if (input.sequenceId) {
            await scopedDb.frameVariants.updateByFrameAndModel(
              input.frameId,
              'image',
              model,
              { status: 'failed', error }
            );
          }

          if (input.sequenceId) {
            try {
              await getGenerationChannel(input.sequenceId).emit(
                'generation.image:progress',
                { frameId: input.frameId, status: 'failed', model }
              );
            } catch {
              // Ignore emit errors in failure handler
            }
          }
        }

        console.error(
          '[ImageWorkflow]',
          `Image generation failed for frame ${input.frameId}: ${error}`
        );
      }

      return `Image generation failed for frame ${input.frameId}`;
    },
  }
);
