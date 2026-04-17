/**
 * Library Talent Sheet Generation Workflow
 *
 * Generates talent reference sheets from user-uploaded reference media.
 * Uses the reference images to create a consistent talent sheet.
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
import {
  buildLibraryTalentSheetPrompt,
  buildTalentHeadshotPrompt,
} from '@/lib/prompts/character-prompt';
import { getTalentChannel } from '@/lib/realtime';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  LibraryTalentSheetWorkflowInput,
  LibraryTalentSheetWorkflowResult,
} from '@/lib/workflow/types';

export const libraryTalentSheetWorkflow = createScopedWorkflow<
  LibraryTalentSheetWorkflowInput,
  LibraryTalentSheetWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;

    // Step 1: Validate input
    await context.run('validate-input', async () => {
      if (!input.talentId) {
        throw new WorkflowValidationError('talentId is required');
      }

      // Verify talent exists and belongs to team
      const talentRecord = await scopedDb.talent.getById(input.talentId);
      if (!talentRecord) {
        throw new WorkflowValidationError('Talent not found');
      }

      const hasReferenceImages =
        input.referenceImageUrls && input.referenceImageUrls.length > 0;
      const imageCount = input.referenceImageUrls?.length ?? 0;

      console.log(
        '[LibraryTalentSheetWorkflow]',
        `Starting sheet generation for talent ${input.talentName}${hasReferenceImages ? ` with ${imageCount} reference images` : ' (no reference images - generating from name/description)'}`
      );

      // Emit generating status
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      await getTalentChannel(input.talentId)?.emit('talent.sheet:progress', {
        talentId: input.talentId,
        status: 'generating',
      });
    });

    // Step 2: Generate the talent sheet image with references
    const imageResult = await context.run('generate-sheet-image', async () => {
      const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;
      const hasReferenceImages =
        input.referenceImageUrls && input.referenceImageUrls.length > 0;
      const prompt = buildLibraryTalentSheetPrompt(
        input.talentName,
        input.talentDescription,
        hasReferenceImages
      );

      console.log(
        '[LibraryTalentSheetWorkflow]',
        `Generating sheet with model ${model}${hasReferenceImages ? ' (with reference images)' : ' (text-to-image only)'}`
      );

      const generationParams: ImageGenerationParams = {
        model,
        prompt,
        imageSize: 'landscape_16_9',
        numImages: 1,
        resolution: '2K',
        traceName: 'talent-sheet-image',
      } satisfies ImageGenerationParams;

      // Only include referenceImageUrls if provided
      if (hasReferenceImages) {
        generationParams.referenceImageUrls = input.referenceImageUrls;
      }

      return await generateImageWithProvider(generationParams, { scopedDb });
    });

    // Deduct credits for sheet generation (skip if team used own fal key)
    await context.run('deduct-credits-sheet', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Talent sheet (${input.imageModel ?? DEFAULT_IMAGE_MODEL})`,
        metadata: { talentId: input.talentId, type: 'sheet' },
        workflowName: 'LibraryTalentSheetWorkflow',
      });
    });

    const imageUrl = imageResult.imageUrls[0];
    if (!imageUrl) {
      throw new Error('No image URL returned from generation');
    }

    // Step 3: Upload to R2 storage
    const storageResult = await context.run('upload-to-storage', async () => {
      console.log('[LibraryTalentSheetWorkflow]', `Uploading sheet to storage`);

      // Fetch and stream directly to R2
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch generated image: ${response.status}`);
      }

      // Build storage path
      const sheetId = generateId();
      const storagePath = `${input.teamId}/${input.talentId}/${sheetId}.png`;

      const result = await uploadResponse(
        response,
        STORAGE_BUCKETS.TALENT,
        storagePath,
        { contentType: 'image/png' }
      );

      return {
        sheetId,
        url: result.publicUrl,
        path: result.path,
      };
    });

    // Step 4: Create talent sheet record
    const sheet = await context.run('create-sheet-record', async () => {
      console.log(
        '[LibraryTalentSheetWorkflow]',
        `Creating sheet record in database`
      );

      return await scopedDb.talent.sheets.create({
        id: storageResult.sheetId,
        talentId: input.talentId,
        name: input.sheetName ?? 'Generated Sheet',
        imageUrl: storageResult.url,
        imagePath: storageResult.path,
        isDefault: false,
        source: 'ai_generated',
      });
    });

    // Step 5: Generate talent headshot for avatar
    const headshotResult = await context.run(
      'generate-headshot-image',
      async () => {
        const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;
        const hasReferenceImages =
          input.referenceImageUrls && input.referenceImageUrls.length > 0;
        const prompt = buildTalentHeadshotPrompt(
          input.talentName,
          input.talentDescription,
          hasReferenceImages
        );

        console.log(
          '[LibraryTalentSheetWorkflow]',
          `Generating headshot with model ${model}${hasReferenceImages ? ' (with reference images)' : ' (text-to-image only)'}`
        );

        const generationParams: ImageGenerationParams = {
          model,
          prompt,
          imageSize: 'square_hd',
          numImages: 1,
          traceName: 'talent-headshot-image',
        } satisfies ImageGenerationParams;

        // Only include referenceImageUrls if provided
        if (hasReferenceImages) {
          generationParams.referenceImageUrls = input.referenceImageUrls;
        }

        return await generateImageWithProvider(generationParams, { scopedDb });
      }
    );

    // Deduct credits for headshot generation (skip if team used own fal key)
    await context.run('deduct-credits-headshot', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(headshotResult.metadata),
        usedOwnKey: headshotResult.metadata.usedOwnKey,
        description: `Talent headshot (${input.imageModel ?? DEFAULT_IMAGE_MODEL})`,
        metadata: { talentId: input.talentId, type: 'headshot' },
        workflowName: 'LibraryTalentSheetWorkflow',
      });
    });

    const headshotUrl = headshotResult.imageUrls[0];
    if (!headshotUrl) {
      throw new Error('No headshot URL returned from generation');
    }

    // Step 6: Upload headshot to R2 storage
    const headshotStorageResult = await context.run(
      'upload-headshot-to-storage',
      async () => {
        console.log(
          '[LibraryTalentSheetWorkflow]',
          `Uploading headshot to storage`
        );

        // Fetch and stream directly to R2
        const response = await fetch(headshotUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch generated headshot: ${response.status}`
          );
        }

        // Build storage path for headshot
        const headshotPath = `${input.teamId}/${input.talentId}/headshot.png`;

        const result = await uploadResponse(
          response,
          STORAGE_BUCKETS.TALENT,
          headshotPath,
          { contentType: 'image/png' }
        );

        return {
          url: result.publicUrl,
          path: result.path,
        };
      }
    );

    // Step 7: Update talent with headshot
    await context.run('update-talent-headshot', async () => {
      console.log(
        '[LibraryTalentSheetWorkflow]',
        `Updating talent with headshot`
      );

      await scopedDb.talent.update(input.talentId, {
        imageUrl: headshotStorageResult.url,
        imagePath: headshotStorageResult.path,
      });
    });

    // Emit completed status
    await context.run('emit-completed', async () => {
      console.log(
        '[LibraryTalentSheetWorkflow]',
        `Talent sheet workflow completed for ${input.talentName}`
      );

      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      await getTalentChannel(input.talentId)?.emit('talent.sheet:progress', {
        talentId: input.talentId,
        status: 'completed',
        sheetId: sheet.id,
        sheetImageUrl: storageResult.url,
        headshotImageUrl: headshotStorageResult.url,
      });
    });

    return {
      sheetId: sheet.id,
      sheetImageUrl: storageResult.url,
      sheetImagePath: storageResult.path,
      headshotImageUrl: headshotStorageResult.url,
      headshotImagePath: headshotStorageResult.path,
    };
  },
  {
    failureFunction: async ({ context, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);

      console.error(
        '[LibraryTalentSheetWorkflow]',
        `Sheet generation failed for talent ${input.talentName}: ${error}`
      );

      // Emit failed status
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      await getTalentChannel(input.talentId)?.emit('talent.sheet:progress', {
        talentId: input.talentId,
        status: 'failed',
        error: `Sheet generation failed: ${error}`,
      });

      return `Talent sheet generation failed for ${input.talentName}`;
    },
  }
);
