/**
 * Frame Images Workflow
 *
 * Orchestrates frame image generation + automatic variant generation.
 * Runs as one strand in parallel with motion-music-prompts-workflow.
 */

import { resolveImageModels } from '@/lib/ai/resolve-image-models';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildElementReferenceImages } from '@/lib/prompts/element-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import { triggerWorkflow } from '@/lib/workflow/client';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  FrameImagesWorkflowInput,
  FrameImagesWorkflowResult,
  ImageWorkflowInput,
  ShotVariantWorkflowInput,
} from '@/lib/workflow/types';
import { getFalFlowControl } from './constants';
import { generateImageWorkflow } from './image-workflow';
import {
  matchCharactersToScene,
  matchElementsToScene,
  matchLocationsToScene,
} from './scene-matching';
import {
  computeFrameImagesHashFromDto,
  type FrameImageSceneSnapshot,
} from './sheet-snapshots';

export const frameImagesWorkflow = createScopedWorkflow<
  FrameImagesWorkflowInput,
  FrameImagesWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;

    await context.run('validate-snapshot', async () => {
      if (context.snapshot) {
        await context.snapshot.validate();
      }
    });
    const {
      scenesWithVisualPrompts,
      charactersWithSheets,
      locationsWithSheets,
      elements: elementsFromInput = [],
      frameMapping,
      imageModel,
      imageModels: imageModelsInput,
      aspectRatio,
      sequenceId,
    } = input;

    const imageModels = resolveImageModels(imageModelsInput, imageModel);

    const label = buildWorkflowLabel(sequenceId);

    // Build per-scene character, location, and element maps for reference image lookup.
    //
    // Re-fetch elements from the DB here (rather than relying on the snapshot
    // taken at analyze-script start). Vision analysis for a slow element may
    // have finished during phases 2–3 — re-fetching picks up the fresh
    // description so the reference image isn't dropped downstream.
    const { sceneCharacterMap, sceneLocationMap, sceneElementMap } =
      await context.run('build-reference-maps', async () => {
        const elements = sequenceId
          ? await scopedDb.sequenceElements.list(sequenceId)
          : elementsFromInput;
        return {
          sceneCharacterMap: Object.fromEntries(
            scenesWithVisualPrompts.map((scene) => [
              scene.sceneId,
              matchCharactersToScene(
                charactersWithSheets,
                scene.continuity?.characterTags || []
              ),
            ])
          ),
          sceneLocationMap: Object.fromEntries(
            scenesWithVisualPrompts.map((scene) => [
              scene.sceneId,
              matchLocationsToScene(
                locationsWithSheets,
                scene.continuity?.environmentTag || '',
                scene.metadata?.location || ''
              ),
            ])
          ),
          sceneElementMap: Object.fromEntries(
            scenesWithVisualPrompts.map((scene) => [
              scene.sceneId,
              matchElementsToScene(
                elements,
                scene.continuity?.elementTags || [],
                scene.originalScript.extract || ''
              ),
            ])
          ),
        };
      });

    const imageSize = aspectRatioToImageSize(aspectRatio);

    // Generate frame images in parallel (for each scene, for each model)
    const imageUrls = await Promise.all(
      scenesWithVisualPrompts.map(async (scene) => {
        const visualPrompt = scene.prompts?.visual?.fullPrompt;
        if (!visualPrompt) {
          throw new WorkflowValidationError(
            `Scene ${scene.sceneId} has no visual prompt`
          );
        }

        const matchedFrame = frameMapping.find(
          (f) => f.sceneId === scene.sceneId
        );

        const characterRefs = buildCharacterReferenceImages(
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
          sceneCharacterMap[scene.sceneId] || []
        );
        const locationRefs = buildLocationReferenceImages(
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
          sceneLocationMap[scene.sceneId] || []
        );
        const elementRefs = buildElementReferenceImages(
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
          sceneElementMap[scene.sceneId] || []
        );
        const allReferences = [
          ...characterRefs,
          ...locationRefs,
          ...elementRefs,
        ];

        // Generate with each selected model in parallel
        const modelResults = await Promise.all(
          imageModels.map(async (model) => {
            const result = await context.invoke(
              `image-${scene.sceneId}-${model}`,
              {
                workflow: generateImageWorkflow,
                label,
                body: {
                  userId: input.userId,
                  teamId: input.teamId,
                  prompt: visualPrompt,
                  model,
                  imageSize,
                  numImages: 1,
                  frameId: matchedFrame?.frameId,
                  sequenceId,
                  referenceImages:
                    allReferences.length > 0 ? allReferences : undefined,
                } satisfies ImageWorkflowInput,
                retries: 3,
                retryDelay: 'pow(2, retried) * 1000',
                flowControl: getFalFlowControl(),
              }
            );

            if (result.isFailed || result.isCanceled || !result.body.imageUrl) {
              throw new WorkflowValidationError(
                `Image generation failed for scene ${scene.sceneId} model ${model}`
              );
            }

            // Trigger variant (shot grid) workflow as a separate top-level
            // run. Fire-and-forget — frame-images shouldn't block on it,
            // since the variant just enriches the frame after the fact and
            // its progress is tracked independently via frame.variantImageStatus.
            await context.run(
              `trigger-variant-${scene.sceneId}-${model}`,
              async () => {
                await triggerWorkflow<ShotVariantWorkflowInput>(
                  '/variant-image',
                  {
                    userId: input.userId,
                    teamId: input.teamId,
                    sequenceId,
                    frameId: matchedFrame?.frameId,
                    thumbnailUrl: result.body.imageUrl,
                    scenePrompt: scene.prompts?.visual?.fullPrompt,
                    characterReferences:
                      characterRefs.length > 0 ? characterRefs : undefined,
                    locationReferences:
                      locationRefs.length > 0 ? locationRefs : undefined,
                    elementReferences:
                      elementRefs.length > 0 ? elementRefs : undefined,
                    aspectRatio,
                    model,
                  },
                  {
                    label,
                    flowControl: getFalFlowControl(),
                    retries: 3,
                    retryDelay: 'pow(2, retried) * 1000',
                  }
                );
              }
            );

            return result.body.imageUrl;
          })
        );

        // Return the primary (first) model's image URL
        return modelResults[0];
      })
    );

    return { imageUrls };
  },
  {
    failureFunction: async ({ context, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);
      console.error(
        '[FrameImagesWorkflow]',
        `Frame image generation failed for sequence ${input.sequenceId}: ${error}`
      );
      return `Frame image generation failed for sequence ${input.sequenceId}: ${error}`;
    },
    snapshot: {
      // The payload binds per-scene character/location/element sheet hashes
      // alongside each reference URL. Validation rejects payloads where the
      // inlined hashes were swapped without recomputing snapshotInputHash.
      // Per-frame divergence routing into `frame_variants` is performed by
      // the downstream image-workflow (which writes the actual artifact);
      // this snapshot config only enforces payload integrity at the batch
      // boundary. See workflow-snapshots-and-content-hash-staleness.md.
      computeFromDto: (input) => {
        const sceneSnapshots: FrameImageSceneSnapshot[] =
          input.sceneSnapshots ?? [];
        return computeFrameImagesHashFromDto({ ...input, sceneSnapshots });
      },
      // NOTE: `computeCurrent` is intentionally an alias of `computeFromDto`
      // here — both hash the same inlined `sceneSnapshots`. This means the
      // batch-level `validate()` only catches payload tampering, not genuine
      // upstream drift. Real drift detection happens per-frame downstream in
      // `generateImageWorkflow`, which re-resolves sheet hashes at write
      // time and routes divergent frames into `frame_variants`.
      computeCurrent: (input) => {
        const sceneSnapshots: FrameImageSceneSnapshot[] =
          input.sceneSnapshots ?? [];
        return computeFrameImagesHashFromDto({ ...input, sceneSnapshots });
      },
    },
  }
);
