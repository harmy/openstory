/**
 * Character Sheet Generation Workflow
 *
 * Generates character reference sheets (full body turnaround) for visual consistency.
 * These sheets are later used as reference images when generating scene images.
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
import { buildCharacterSheetPrompt } from '@/lib/prompts/character-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  CharacterSheetWorkflowInput,
  CharacterSheetWorkflowResult,
} from '@/lib/workflow/types';

export const characterSheetWorkflow = createScopedWorkflow<
  CharacterSheetWorkflowInput,
  CharacterSheetWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;

    // Emit realtime event that generation has started
    await context.run('emit-start-event', async () => {
      if (input.sequenceId && input.characterDbId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.character-sheet:progress',
          {
            characterId: input.characterDbId,
            status: 'generating',
          }
        );
      }
    });

    // Step 1: Validate and build prompt
    const generationParams: ImageGenerationParams = await context.run(
      'build-prompt',
      async () => {
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        if (!input.characterMetadata) {
          throw new WorkflowValidationError('characterMetadata is required');
        }

        const hasTalent = !!(input.talentMetadata || input.talentDescription);
        console.log(
          '[CharacterSheetWorkflow]',
          `Starting sheet generation for character ${input.characterName}${hasTalent ? ' with talent appearance' : ''}`
        );

        // Build talent overrides if talent data is provided (for casting)
        const talentOverrides = hasTalent
          ? {
              sheetMetadata: input.talentMetadata,
              description: input.talentDescription,
              sheetImageUrl: input.referenceImageUrl,
            }
          : undefined;

        // Build prompt with character identity + talent appearance + sequence style
        const { prompt, referenceUrls } = buildCharacterSheetPrompt(
          input.characterMetadata,
          talentOverrides,
          input.styleConfig
        );
        const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

        return {
          model,
          prompt,
          // Character sheets use landscape aspect ratio for multi-panel layout
          imageSize: 'landscape_16_9' as const,
          numImages: 1,
          // Use talent reference image(s) for visual consistency
          referenceImageUrls:
            referenceUrls.length > 0 ? referenceUrls : undefined,
          traceName: 'character-sheet-image',
        } satisfies ImageGenerationParams;
      }
    );

    // Step 2: Generate the character sheet image
    const imageResult = await context.run('generate-sheet-image', async () => {
      console.log(
        '[CharacterSheetWorkflow]',
        `Generating sheet for ${input.characterName} with model ${generationParams.model}`
      );

      return await generateImageWithProvider(generationParams, { scopedDb });
    });

    // Deduct credits for image generation (skip if team used own fal key)
    await context.run('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Character sheet (${generationParams.model})`,
        metadata: {
          model: generationParams.model,
          characterName: input.characterName,
          characterDbId: input.characterDbId,
        },
        workflowName: 'CharacterSheetWorkflow',
      });
    });

    let sheetImageUrl = imageResult.imageUrls[0];
    let sheetImagePath: string | undefined = undefined;

    if (input.characterDbId && input.teamId && input.sequenceId) {
      // Step 3: Upload to R2 storage
      const storageResult = await context.run('upload-to-storage', async () => {
        const imageUrl = imageResult.imageUrls[0];
        if (!imageUrl) {
          throw new Error('No image URL returned from generation');
        }

        console.log(
          '[CharacterSheetWorkflow]',
          `Uploading sheet to storage for ${input.characterName}`
        );

        // Fetch and stream directly to R2
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch generated image: ${response.status}`
          );
        }

        // Build storage path: characters/{teamId}/{sequenceId}/{characterDbId}/{uniqueId}.png
        const uniqueId = generateId();
        const storagePath = `${input.teamId}/${input.sequenceId}/${input.characterDbId}/${uniqueId}.png`;

        const result = await uploadResponse(
          response,
          STORAGE_BUCKETS.CHARACTERS,
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

      // Step 4: Update database with completed sheet
      await context.run('update-database', async () => {
        console.log(
          '[CharacterSheetWorkflow]',
          `Updating database for ${input.characterName}`
        );

        await scopedDb.characters.updateSheet(
          input.characterDbId,
          storageResult.url,
          storageResult.path
        );
      });

      sheetImagePath = storageResult.path;
      sheetImageUrl = storageResult.url;
    }
    // Emit realtime event that generation is complete
    await context.run('emit-complete-event', async () => {
      if (input.sequenceId && input.characterDbId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.character-sheet:progress',
          {
            characterId: input.characterDbId,
            status: 'completed',
            sheetImageUrl,
          }
        );
      }
    });

    console.log(
      '[CharacterSheetWorkflow]',
      `Character sheet workflow completed for ${input.characterName}`
    );

    const result: CharacterSheetWorkflowResult = {
      sheetImageUrl,
      sheetImagePath,
      characterDbId: input.characterDbId,
    };

    return result;
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);

      // Mark character sheet as failed
      if (input.characterDbId) {
        await scopedDb.characters.updateSheetStatus(
          input.characterDbId,
          'failed',
          error
        );

        // Emit failure event for realtime UI update
        if (input.sequenceId) {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.character-sheet:progress',
            {
              characterId: input.characterDbId,
              status: 'failed',
              error,
            }
          );
        }

        console.error(
          '[CharacterSheetWorkflow]',
          `Sheet generation failed for character ${input.characterName}: ${error}`
        );
      }

      return `Character sheet generation failed for ${input.characterName}`;
    },
  }
);
