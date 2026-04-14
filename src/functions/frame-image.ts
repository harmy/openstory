import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  estimateImageCost,
  estimateStoryboardCost,
} from '@/lib/billing/cost-estimation';
import { requireCredits } from '@/lib/billing/preflight';
import {
  aspectRatioToImageSize,
  getVariantGridConfig,
} from '@/lib/constants/aspect-ratios';
import type { Character, SequenceLocation } from '@/lib/db/schema';
import { locationMatchesTag } from '@/lib/db/scoped/sequence-locations';
import { cropTileFromGrid } from '@/lib/image/image-crop';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import {
  generateVariantSchema,
  regenerateFrameSchema,
} from '@/lib/schemas/frame.schemas';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type {
  ImageWorkflowInput,
  StoryboardWorkflowInput,
  UpscaleVariantWorkflowInput,
  VariantWorkflowInput,
} from '@/lib/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { frameAccessMiddleware, sequenceAccessMiddleware } from './middleware';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Match characters by continuity tags and return their reference sheet images. */
function getSceneCharacterReferenceImages(
  allCharacters: Character[],
  characterTags: string[]
): ReferenceImageDescription[] {
  if (characterTags.length === 0) return [];

  const matchedCharacters = allCharacters.filter((char) => {
    const consistencyTag = (char.consistencyTag ?? '').toLowerCase();
    const charName = char.name.toLowerCase();

    return characterTags.some((tag) => {
      const tagLower = tag.toLowerCase();
      return (
        (consistencyTag && tagLower.includes(consistencyTag)) ||
        tagLower.includes(charName) ||
        tagLower.includes(char.characterId.toLowerCase())
      );
    });
  });

  return buildCharacterReferenceImages(matchedCharacters);
}

/** Match locations by environmentTag or scene location and return reference images. */
function getSceneLocationReferenceImages(
  allLocations: SequenceLocation[],
  environmentTag: string,
  sceneLocation?: string
): ReferenceImageDescription[] {
  if (!environmentTag && !sceneLocation) return [];

  const matchedLocations = allLocations.filter(
    (loc) =>
      (environmentTag && locationMatchesTag(loc, environmentTag)) ||
      (sceneLocation && locationMatchesTag(loc, sceneLocation))
  );

  return buildLocationReferenceImages(matchedLocations);
}

// ---------------------------------------------------------------------------
// Generate Frames (Storyboard Workflow)
// ---------------------------------------------------------------------------

export const generateFramesFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const { sequence, user } = context;

    await requireCredits(
      context.scopedDb,
      estimateStoryboardCost({
        imageModel: safeTextToImageModel(
          sequence.imageModel,
          DEFAULT_IMAGE_MODEL
        ),
        aspectRatio: sequence.aspectRatio,
        videoModel: safeImageToVideoModel(
          sequence.videoModel,
          DEFAULT_VIDEO_MODEL
        ),
      }),
      {
        providers: ['fal', 'openrouter'],
        errorMessage: 'Insufficient credits to generate storyboard',
      }
    );

    const workflowInput: StoryboardWorkflowInput = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      options: {
        framesPerScene: 3,
        generateThumbnails: true,
        generateDescriptions: true,
        aiProvider: 'openrouter',
        regenerateAll: true,
      },
    };

    const workflowRunId = await triggerWorkflow('/storyboard', workflowInput, {
      deduplicationId: `storyboard-${sequence.id}-${Date.now()}`,
      label: buildWorkflowLabel(sequence.id),
    });

    return { workflowRunId, frames: [] };
  });

// ---------------------------------------------------------------------------
// Generate Image for Frame
// ---------------------------------------------------------------------------

const generateImageInputSchema = regenerateFrameSchema.extend({
  sequenceId: ulidSchema,
  frameId: ulidSchema,
});

export const generateFrameImageFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(generateImageInputSchema))
  .handler(async ({ context, data }) => {
    const { frame, sequence, user } = context;

    // Priority: provided > stored > AI-generated > description
    const prompt =
      data.prompt ||
      frame.imagePrompt ||
      frame.metadata?.prompts?.visual?.fullPrompt ||
      frame.description;

    if (!prompt) {
      throw new Error('Frame has no prompt or description to regenerate from');
    }

    const allCharacters = await context.scopedDb.characters.listWithSheets(
      sequence.id
    );
    const characterTags = frame.metadata?.continuity?.characterTags ?? [];
    const characterReferences = getSceneCharacterReferenceImages(
      allCharacters,
      characterTags
    );

    const allLocations =
      await context.scopedDb.sequenceLocations.listWithReferences(sequence.id);
    const locationReferences = getSceneLocationReferenceImages(
      allLocations,
      frame.metadata?.continuity?.environmentTag ?? '',
      frame.metadata?.metadata?.location ?? ''
    );

    const model =
      data.model || safeTextToImageModel(frame.imageModel, DEFAULT_IMAGE_MODEL);

    await requireCredits(
      context.scopedDb,
      estimateImageCost(model, sequence.aspectRatio, 1),
      { errorMessage: 'Insufficient credits for image generation' }
    );

    const workflowInput: ImageWorkflowInput = {
      userId: user.id,
      teamId: sequence.teamId,
      prompt,
      model,
      imageSize: aspectRatioToImageSize(sequence.aspectRatio),
      numImages: 1,
      frameId: frame.id,
      sequenceId: sequence.id,
      referenceImages: [...characterReferences, ...locationReferences],
    };

    const workflowRunId = await triggerWorkflow('/image', workflowInput, {
      deduplicationId: `image-${frame.id}-${Date.now()}`,
      label: buildWorkflowLabel(sequence.id),
    });

    return { workflowRunId, frameId: frame.id };
  });

// ---------------------------------------------------------------------------
// Generate Variants for Frame
// ---------------------------------------------------------------------------

const generateVariantsInputSchema = generateVariantSchema.extend({
  sequenceId: ulidSchema,
  frameId: ulidSchema,
});

export const generateFrameVariantsFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(generateVariantsInputSchema))
  .handler(async ({ context, data }) => {
    const { frame, sequence, user } = context;

    if (!frame.thumbnailUrl) {
      throw new Error('Frame must have a thumbnail image to generate variants');
    }

    const allCharacters = await context.scopedDb.characters.listWithSheets(
      sequence.id
    );
    const characterTags = frame.metadata?.continuity?.characterTags ?? [];
    const characterReferences = getSceneCharacterReferenceImages(
      allCharacters,
      characterTags
    );

    const allLocations =
      await context.scopedDb.sequenceLocations.listWithReferences(sequence.id);
    const locationReferences = getSceneLocationReferenceImages(
      allLocations,
      frame.metadata?.continuity?.environmentTag ?? '',
      frame.metadata?.metadata?.location ?? ''
    );

    const numImages = data.numImages ?? 1;
    await requireCredits(
      context.scopedDb,
      estimateImageCost(
        data.model ?? DEFAULT_IMAGE_MODEL,
        sequence.aspectRatio,
        numImages
      ),
      { errorMessage: 'Insufficient credits for variant generation' }
    );

    const gridConfig = getVariantGridConfig(sequence.aspectRatio);

    const workflowInput: VariantWorkflowInput = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      frameId: frame.id,
      thumbnailUrl: frame.thumbnailUrl,
      scenePrompt: frame.metadata?.prompts?.visual?.fullPrompt,
      model: data.model,
      aspectRatio: sequence.aspectRatio,
      imageSize: data.imageSize || gridConfig.imageSize,
      numImages,
      seed: data.seed,
      characterReferences,
      locationReferences,
    };

    const workflowRunId = await triggerWorkflow(
      '/variant-image',
      workflowInput,
      {
        deduplicationId: `variant-${frame.id}-${Date.now()}`,
        label: buildWorkflowLabel(sequence.id),
      }
    );

    return { workflowRunId, frameId: frame.id };
  });

// ---------------------------------------------------------------------------
// Select Variant
// ---------------------------------------------------------------------------

const selectVariantInputSchema = z.object({
  sequenceId: ulidSchema,
  frameId: ulidSchema,
  variantIndex: z.number().int().min(0).max(8),
});

/** Convert flat grid index to 1-based row/col given the number of columns. */
function indexToRowCol(
  index: number,
  cols: number
): { row: number; col: number } {
  return {
    row: Math.floor(index / cols) + 1,
    col: (index % cols) + 1,
  };
}

export const selectFrameVariantFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(selectVariantInputSchema))
  .handler(async ({ context, data }) => {
    const { frame, sequence, user } = context;

    if (!frame.variantImageUrl) {
      throw new Error('Frame has no variant image to select from');
    }

    const gridConfig = getVariantGridConfig(sequence.aspectRatio);

    if (data.variantIndex >= gridConfig.count) {
      throw new Error(
        `Variant index ${data.variantIndex} exceeds grid count ${gridConfig.count}`
      );
    }

    const { row, col } = indexToRowCol(data.variantIndex, gridConfig.cols);

    // Construct a Cloudflare Image Resizing crop URL instead of downloading
    // and WASM-processing the grid image in-Worker. FAL fetches the cropped
    // tile directly from this URL when upscaling.
    const cropResult = await cropTileFromGrid({
      gridImageUrl: frame.variantImageUrl,
      row,
      col,
      gridCols: gridConfig.cols,
      gridRows: gridConfig.rows,
    });

    // Set cropped thumbnail URL and clear stale motion fields
    await context.scopedDb.frames.update(frame.id, {
      thumbnailUrl: cropResult.url,
      thumbnailPath: null,
      thumbnailStatus: 'generating',
      thumbnailError: null,
      videoUrl: null,
      videoPath: null,
      videoStatus: 'pending',
      videoWorkflowRunId: null,
      videoGeneratedAt: null,
      videoError: null,
    });

    // Fetch character and location references for upscale consistency
    const allCharacters = await context.scopedDb.characters.listWithSheets(
      sequence.id
    );
    const characterTags = frame.metadata?.continuity?.characterTags ?? [];
    const characterReferences = getSceneCharacterReferenceImages(
      allCharacters,
      characterTags
    );

    const allLocations =
      await context.scopedDb.sequenceLocations.listWithReferences(sequence.id);
    const locationReferences = getSceneLocationReferenceImages(
      allLocations,
      frame.metadata?.continuity?.environmentTag ?? '',
      frame.metadata?.metadata?.location ?? ''
    );

    await requireCredits(
      context.scopedDb,
      estimateImageCost('nano_banana_2', sequence.aspectRatio, 1),
      { errorMessage: 'Insufficient credits for variant upscale' }
    );

    const workflowInput: UpscaleVariantWorkflowInput = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      frameId: frame.id,
      croppedTileUrl: cropResult.url,
      croppedTilePath: '',
      aspectRatio: sequence.aspectRatio,
      characterReferences,
      locationReferences,
    };

    const workflowRunId = await triggerWorkflow(
      '/upscale-variant',
      workflowInput,
      {
        deduplicationId: `upscale-variant-${frame.id}-${Date.now()}`,
        label: buildWorkflowLabel(sequence.id),
      }
    );

    return {
      frameId: frame.id,
      thumbnailUrl: cropResult.url,
      variantIndex: data.variantIndex,
      upscaleWorkflowRunId: workflowRunId,
    };
  });

// ---------------------------------------------------------------------------
// Set Image from Variant
// ---------------------------------------------------------------------------

const setImageFromVariantInputSchema = z.object({
  sequenceId: ulidSchema,
  frameId: ulidSchema,
  model: z.string().min(1),
});

export const setImageFromVariantFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(setImageFromVariantInputSchema))
  .handler(async ({ context, data }) => {
    const { frame } = context;

    const variant = await context.scopedDb.frameVariants.getByFrameAndModel(
      frame.id,
      'image',
      data.model
    );

    if (!variant || variant.status !== 'completed' || !variant.url) {
      throw new Error('No completed variant found for this model');
    }

    await context.scopedDb.frames.update(frame.id, {
      thumbnailUrl: variant.url,
      thumbnailPath: variant.storagePath,
      thumbnailStatus: 'completed',
      thumbnailError: null,
      imageModel: data.model,
      // Clear stale video fields — video must be regenerated
      videoUrl: null,
      videoPath: null,
      videoStatus: 'pending',
      videoWorkflowRunId: null,
      videoGeneratedAt: null,
      videoError: null,
    });

    return { frameId: frame.id, thumbnailUrl: variant.url };
  });
