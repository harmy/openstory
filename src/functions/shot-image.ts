import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import { resolveSceneImageModel } from '@/lib/ai/resolve-scene-models';
import {
  estimateImageCost,
  estimateStoryboardCost,
} from '@/lib/billing/cost-estimation';
import { requireCredits } from '@/lib/billing/preflight';
import {
  aspectRatioToImageSize,
  getVariantGridConfig,
} from '@/lib/constants/aspect-ratios';
import { dbSceneId, type SequenceLocation } from '@/lib/db/schema';
import { locationMatchesTag } from '@/lib/db/scoped/sequence-locations';
import { cropTileFromGrid } from '@/lib/image/image-crop';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildElementReferenceImages } from '@/lib/prompts/element-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import {
  generateVariantSchema,
  regenerateShotSchema,
} from '@/lib/schemas/shot.schemas';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { rescanContinuityFromPrompt } from '@/lib/scenes/rescan-continuity-from-prompt';
import { triggerWorkflow } from '@/lib/workflow/client';
import { triggerStoryboard } from '@/lib/workflow/launchers';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type {
  ShotImageSceneSnapshot,
  ImageWorkflowInput,
  StoryboardWorkflowInput,
  ShotVariantWorkflowInput,
  UpscaleShotVariantWorkflowInput,
} from '@/lib/workflow/types';
import {
  matchCharactersToScene,
  matchElementsToScene,
  matchLocationsToScene,
} from '@/lib/workflows/scene-matching';
import { computeShotImageSceneHash } from '@/lib/workflows/sheet-snapshots';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { shotAccessMiddleware, sequenceAccessMiddleware } from './middleware';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
// Generate Shots (Storyboard Workflow)
// ---------------------------------------------------------------------------

export const generateShotsFn = createServerFn({ method: 'POST' })
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
        videoModels: [
          safeImageToVideoModel(sequence.videoModel, DEFAULT_VIDEO_MODEL),
        ],
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
        shotsPerScene: 3,
        generateThumbnails: true,
        generateDescriptions: true,
        aiProvider: 'openrouter',
        regenerateAll: true,
      },
    };

    // Owns the generation mutex, the 'processing' status write, and the
    // run-id persistence (#839).
    const { workflowRunId } = await triggerStoryboard(
      context.scopedDb,
      workflowInput
    );

    return { workflowRunId, shots: [] };
  });

// ---------------------------------------------------------------------------
// Generate Image for Shot
// ---------------------------------------------------------------------------

const generateImageInputSchema = regenerateShotSchema.extend({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

export const generateShotImageFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(generateImageInputSchema))
  .handler(async ({ context, data }) => {
    const { shot, frame, sequence, user } = context;

    // Priority: provided > stored (anchor frame, #989) > AI-generated > description
    const prompt =
      data.prompt ||
      frame.imagePrompt ||
      shot.metadata?.prompts?.visual?.fullPrompt ||
      shot.description;

    if (!prompt) {
      throw new Error('Shot has no prompt or description to regenerate from');
    }

    // Auto-link any element/cast/location tags the user mentioned in their
    // edited prompt before computing reference attachment, so a freshly-
    // mentioned LOGO gets its reference image attached to THIS regeneration.
    // updateShotFn does the same rescan, but the UI never calls it — the
    // regenerate buttons are the only persistence path for prompts today.
    const userEditedPrompt = data.prompt !== undefined;
    const baseContinuity = shot.metadata?.continuity;
    let continuity = baseContinuity;
    if (userEditedPrompt && shot.metadata && baseContinuity) {
      const rescan = await rescanContinuityFromPrompt({
        scopedDb: context.scopedDb,
        sequenceId: sequence.id,
        existing: baseContinuity,
        promptText: prompt,
      });
      if (rescan.changed) {
        continuity = rescan.continuity;
        await context.scopedDb.shots.update(shot.id, {
          metadata: { ...shot.metadata, continuity: rescan.continuity },
        });
      }
    }

    const allCharacters = await context.scopedDb.characters.listWithSheets(
      sequence.id
    );
    const matchedCharacters = matchCharactersToScene(
      allCharacters,
      continuity?.characterTags ?? []
    );
    const characterReferences =
      buildCharacterReferenceImages(matchedCharacters);

    const allLocations =
      await context.scopedDb.sequenceLocations.listWithReferences(sequence.id);
    const matchedLocations = matchLocationsToScene(
      allLocations,
      continuity?.environmentTag ?? '',
      shot.metadata?.metadata?.location ?? ''
    );
    const locationReferences = getSceneLocationReferenceImages(
      allLocations,
      continuity?.environmentTag ?? '',
      shot.metadata?.metadata?.location ?? ''
    );

    const allElements = await context.scopedDb.sequenceElements.list(
      sequence.id
    );
    const matchedElements = matchElementsToScene(
      allElements,
      continuity?.elementTags ?? [],
      shot.metadata?.originalScript.extract ?? ''
    );
    const elementReferences = buildElementReferenceImages(matchedElements);

    // Model selection lives at the scene level (#909): an explicit per-request
    // model wins (one-off variant generation), otherwise the shot's parent
    // scene drives it, falling back to the sequence default.
    const scene = shot.sceneId
      ? await context.scopedDb.scenes.getById(dbSceneId(shot.sceneId))
      : null;
    const model = data.model || resolveSceneImageModel(scene, sequence);

    await requireCredits(
      context.scopedDb,
      estimateImageCost(model, sequence.aspectRatio, 1),
      { errorMessage: 'Insufficient credits for image generation' }
    );

    // Build a per-scene snapshot so the image workflow records a non-null
    // `thumbnailInputHash`. Without this the convergent write path stores
    // `null`, and the staleness check loses the ability to flip back to
    // 'stale' on a future prompt regenerate. The sceneId fallback covers
    // legacy shots generated before scene metadata was attached.
    const sortedHashes = (
      values: ReadonlyArray<string | null | undefined>
    ): string[] =>
      values
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .sort();
    const sceneSnapshot: ShotImageSceneSnapshot = {
      sceneId: shot.metadata?.sceneId ?? shot.id,
      visualPrompt: prompt,
      characterSheetHashes: sortedHashes(
        matchedCharacters.map((c) => c.sheetInputHash)
      ),
      locationSheetHashes: sortedHashes(
        matchedLocations.map((l) => l.referenceInputHash)
      ),
      elementReferenceHashes: sortedHashes(
        matchedElements.map((e) => e.imageUrl)
      ),
    };
    const snapshotInputHash = await computeShotImageSceneHash(
      sceneSnapshot,
      model,
      sequence.aspectRatio
    );

    const workflowInput: ImageWorkflowInput = {
      userId: user.id,
      teamId: sequence.teamId,
      prompt,
      model,
      imageSize: aspectRatioToImageSize(sequence.aspectRatio),
      numImages: 1,
      shotId: shot.id,
      sequenceId: sequence.id,
      aspectRatio: sequence.aspectRatio,
      sceneSnapshot,
      snapshotInputHash,
      referenceImages: [
        ...characterReferences,
        ...locationReferences,
        ...elementReferences,
      ],
      userEditedPrompt,
    };

    const workflowRunId = await triggerWorkflow('/image', workflowInput, {
      deduplicationId: `image-${shot.id}-${Date.now()}`,
      label: buildWorkflowLabel(sequence.id),
    });

    return { workflowRunId, shotId: shot.id };
  });

// ---------------------------------------------------------------------------
// Generate Variants for Shot
// ---------------------------------------------------------------------------

const generateVariantsInputSchema = generateVariantSchema.extend({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
});

export const generateShotVariantsFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(generateVariantsInputSchema))
  .handler(async ({ context, data }) => {
    const { shot, frame, sequence, user } = context;

    if (!frame.imageUrl) {
      throw new Error('Shot must have a still image to generate variants');
    }

    const allCharacters = await context.scopedDb.characters.listWithSheets(
      sequence.id
    );
    const characterTags = shot.metadata?.continuity?.characterTags ?? [];
    const characterReferences = buildCharacterReferenceImages(
      matchCharactersToScene(allCharacters, characterTags)
    );

    const allLocations =
      await context.scopedDb.sequenceLocations.listWithReferences(sequence.id);
    const locationReferences = getSceneLocationReferenceImages(
      allLocations,
      shot.metadata?.continuity?.environmentTag ?? '',
      shot.metadata?.metadata?.location ?? ''
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

    const workflowInput: ShotVariantWorkflowInput = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      shotId: shot.id,
      thumbnailUrl: frame.imageUrl,
      scenePrompt: shot.metadata?.prompts?.visual?.fullPrompt,
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
        deduplicationId: `variant-${shot.id}-${Date.now()}`,
        label: buildWorkflowLabel(sequence.id),
      }
    );

    return { workflowRunId, shotId: shot.id };
  });

// ---------------------------------------------------------------------------
// Select Variant
// ---------------------------------------------------------------------------

const selectVariantInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
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

export const selectShotVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(selectVariantInputSchema))
  .handler(async ({ context, data }) => {
    const { shot, frame, sequence, user } = context;

    // The 3×3 grid sheet is the latest `kind:'framing'` `frame_variants` version
    // (#989). Selecting a tile spawns a new framing version (the upscaled tile)
    // pointing back at this sheet, then repoints the selection — never an
    // overwrite.
    const sheet = await context.scopedDb.frameVariants.getLatestGridSheet(
      frame.id
    );
    if (!sheet?.url) {
      throw new Error('Shot has no variant grid to select from');
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
      gridImageUrl: sheet.url,
      row,
      col,
      gridCols: gridConfig.cols,
      gridRows: gridConfig.rows,
    });

    // Fetch character and location references for upscale consistency
    const allCharacters = await context.scopedDb.characters.listWithSheets(
      sequence.id
    );
    const characterTags = shot.metadata?.continuity?.characterTags ?? [];
    const characterReferences = buildCharacterReferenceImages(
      matchCharactersToScene(allCharacters, characterTags)
    );

    const allLocations =
      await context.scopedDb.sequenceLocations.listWithReferences(sequence.id);
    const locationReferences = getSceneLocationReferenceImages(
      allLocations,
      shot.metadata?.continuity?.environmentTag ?? '',
      shot.metadata?.metadata?.location ?? ''
    );

    await requireCredits(
      context.scopedDb,
      estimateImageCost('nano_banana_2', sequence.aspectRatio, 1),
      { errorMessage: 'Insufficient credits for variant upscale' }
    );

    const workflowInput: UpscaleShotVariantWorkflowInput = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      shotId: shot.id,
      croppedTileUrl: cropResult.url,
      croppedTilePath: '',
      aspectRatio: sequence.aspectRatio,
      characterReferences,
      locationReferences,
      // The framing version the upscaled tile derives from (#989) — the upscale
      // workflow records it as `frame_variants.sourceVariantId`.
      sourceVariantId: sheet.id,
    };

    const workflowRunId = await triggerWorkflow(
      '/upscale-variant',
      workflowInput,
      {
        deduplicationId: `upscale-variant-${shot.id}-${Date.now()}`,
        label: buildWorkflowLabel(sequence.id),
      }
    );

    return {
      shotId: shot.id,
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
  shotId: ulidSchema,
  model: z.string().min(1),
});

export const setImageFromVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(setImageFromVariantInputSchema))
  .handler(async ({ context, data }) => {
    const { shot, frame } = context;

    // The model's image versions live in `frame_variants` now (#989). Pick the
    // latest completed one and SELECT it — a pointer repoint that mirrors its
    // image fields onto the frame + logs `image.selected`. This is the #677 fix:
    // selecting a model is a retained version + repoint, never an overwrite, so
    // the old "set image shows old image" / false-staleness bugs disappear (the
    // version carries its own inputHash; the mirror adopts it).
    const versions = await context.scopedDb.frameVariants.listByGroup({
      frameId: frame.id,
      kind: 'model',
      model: data.model,
    });
    const latest = [...versions]
      .reverse()
      .find((v) => v.status === 'completed' && v.url);
    if (!latest) {
      throw new Error('No completed variant found for this model');
    }

    await context.scopedDb.frameVariants.select(frame.id, latest.id, {
      actorId: context.user.id,
    });

    // A new still invalidates downstream video (still on `shots` until Phase 3).
    await context.scopedDb.shots.update(shot.id, {
      videoUrl: null,
      videoPath: null,
      videoStatus: 'pending',
      videoWorkflowRunId: null,
      videoGeneratedAt: null,
      videoError: null,
    });

    return { shotId: shot.id, thumbnailUrl: latest.url };
  });

const setVideoFromVariantInputSchema = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  model: z.string().min(1),
});

/**
 * Promote a model's video variant to the shot's primary video (#545) — the
 * motion analog of `setImageFromVariantFn`. Copies the variant's url/path into
 * `shots.video*` so the player and exports use it, non-destructively (the
 * variant row is retained, so the viewer can switch back). Unlike the image
 * version there is nothing downstream to invalidate — video is the terminal
 * artifact.
 */
export const setVideoFromVariantFn = createServerFn({ method: 'POST' })
  .middleware([shotAccessMiddleware])
  .inputValidator(zodValidator(setVideoFromVariantInputSchema))
  .handler(async ({ context, data }) => {
    const { shot } = context;

    const variant = await context.scopedDb.shotVariants.getByShotAndModel(
      shot.id,
      'video',
      data.model
    );

    if (!variant || variant.status !== 'completed' || !variant.url) {
      throw new Error('No completed video variant found for this model');
    }

    await context.scopedDb.shots.update(shot.id, {
      videoUrl: variant.url,
      videoPath: variant.storagePath,
      videoStatus: 'completed',
      videoError: null,
      videoGeneratedAt: new Date(),
      videoInputHash: variant.inputHash,
      durationMs: variant.durationMs,
      motionModel: data.model,
    });

    return { shotId: shot.id, videoUrl: variant.url };
  });
