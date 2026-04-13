/**
 * Location Sheet Generation Workflow
 *
 * Generates location reference images (establishing shots) for visual consistency.
 * These images are later used as reference images when generating scene images.
 */

import { uploadResponse } from '@/lib/storage/upload-response';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import {
  deductWorkflowCredits,
  extractImageCost,
} from '@/lib/billing/workflow-deduction';
import { generateId } from '@/lib/db/id';
import {
  generateImageWithProvider,
  type ImageGenerationParams,
} from '@/lib/image/image-generation';
import { buildLocationSheetPrompt } from '@/lib/prompts/location-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  LocationSheetWorkflowInput,
  LocationSheetWorkflowResult,
} from '@/lib/workflow/types';

export const locationSheetWorkflow = createScopedWorkflow<
  LocationSheetWorkflowInput,
  LocationSheetWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;

    // Emit realtime event that generation has started
    await context.run('emit-start-event', async () => {
      if (input.sequenceId && input.locationDbId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.location-sheet:progress',
          {
            locationId: input.locationDbId,
            status: 'generating',
          }
        );
      }
    });

    // Step 1: Validate and build prompt
    const generationParams: ImageGenerationParams = await context.run(
      'build-prompt',
      async () => {
        if (!input.locationMetadata) {
          throw new WorkflowValidationError('locationMetadata is required');
        }

        const hasLibraryLocation = !!(
          input.referenceImageUrl || input.libraryLocationDescription
        );
        console.log(
          '[LocationSheetWorkflow]',
          `Starting reference generation for location ${input.locationName}${hasLibraryLocation ? ' with library location reference' : ''}`
        );

        // Build library location overrides if data is provided
        const libraryOverrides = hasLibraryLocation
          ? {
              description: input.libraryLocationDescription,
              referenceImageUrl: input.referenceImageUrl,
            }
          : undefined;

        // Build prompt with location identity + library reference + sequence style
        const { prompt, referenceUrls } = buildLocationSheetPrompt(
          input.locationMetadata,
          libraryOverrides,
          input.styleConfig
        );
        const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

        return {
          model,
          prompt,
          // Location reference images use landscape aspect ratio for establishing shots
          imageSize: 'landscape_16_9' as const,
          numImages: 1,
          // Use library reference image(s) for visual consistency
          referenceImageUrls:
            referenceUrls.length > 0 ? referenceUrls : undefined,
          traceName: 'location-sheet-image',
        } satisfies ImageGenerationParams;
      }
    );

    // Step 2: Generate the location reference image
    const imageResult = await context.run(
      'generate-reference-image',
      async () => {
        console.log(
          '[LocationSheetWorkflow]',
          `Generating reference for ${input.locationName} with model ${generationParams.model}`
        );

        return await generateImageWithProvider(generationParams, { scopedDb });
      }
    );

    // Deduct credits for image generation (skip if team used own fal key)
    await context.run('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Location sheet (${generationParams.model})`,
        metadata: {
          model: generationParams.model,
          locationName: input.locationName,
          locationDbId: input.locationDbId,
        },
        workflowName: 'LocationSheetWorkflow',
      });
    });

    let referenceImageUrl = imageResult.imageUrls[0];
    let referenceImagePath: string | undefined = undefined;

    if (input.locationDbId && input.teamId && input.sequenceId) {
      // Step 3: Upload to R2 storage
      const storageResult = await context.run('upload-to-storage', async () => {
        const imageUrl = imageResult.imageUrls[0];
        if (!imageUrl) {
          throw new Error('No image URL returned from generation');
        }

        console.log(
          '[LocationSheetWorkflow]',
          `Uploading reference to storage for ${input.locationName}`
        );

        // Fetch and stream directly to R2
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch generated image: ${response.status}`
          );
        }

        // Build storage path: locations/{teamId}/{sequenceId}/{locationDbId}/{uniqueId}.png
        const uniqueId = generateId();
        const storagePath = `${input.teamId}/${input.sequenceId}/${input.locationDbId}/${uniqueId}.png`;

        const result = await uploadResponse(
          response,
          STORAGE_BUCKETS.LOCATIONS,
          storagePath,
          {
            contentType: 'image/png',
          }
        );

        return {
          url: result.publicUrl,
          path: result.path,
        };
      });

      // Step 4: Update database with completed reference
      await context.run('update-database', async () => {
        console.log(
          '[LocationSheetWorkflow]',
          `Updating database for ${input.locationName}`
        );

        await scopedDb.sequenceLocations.updateReference(
          input.locationDbId,
          storageResult.url,
          storageResult.path
        );
      });

      referenceImagePath = storageResult.path;
      referenceImageUrl = storageResult.url;
    }

    // Emit realtime event that generation is complete
    await context.run('emit-complete-event', async () => {
      if (input.sequenceId && input.locationDbId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.location-sheet:progress',
          {
            locationId: input.locationDbId,
            status: 'completed',
            referenceImageUrl,
          }
        );
      }
    });

    console.log(
      '[LocationSheetWorkflow]',
      `Location reference workflow completed for ${input.locationName}`
    );

    const result: LocationSheetWorkflowResult = {
      referenceImageUrl,
      referenceImagePath,
      locationDbId: input.locationDbId,
    };

    return result;
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);

      // Mark location reference as failed
      if (input.locationDbId && input.teamId) {
        await scopedDb.sequenceLocations.updateReferenceStatus(
          input.locationDbId,
          'failed',
          error
        );

        // Emit failure event for realtime UI update
        if (input.sequenceId) {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.location-sheet:progress',
            {
              locationId: input.locationDbId,
              status: 'failed',
              error,
            }
          );
        }

        console.error(
          '[LocationSheetWorkflow]',
          `Reference generation failed for location ${input.locationName}: ${error}`
        );
      }

      return `Location reference generation failed for ${input.locationName}`;
    },
  }
);
