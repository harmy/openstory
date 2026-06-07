/**
 * Cloudflare Workflows port of `frameImagesWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/frame-images-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * Differences (all infrastructure-level, not behavioural):
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` and the run id from
 *     `event.instanceId` instead of `context.requestPayload` /
 *     `context.workflowRunId`.
 *   - Calls the snapshot DTO computer directly in a `validate-snapshot`
 *     step instead of going through the `context.snapshot.*` extension.
 *   - Per-scene × per-model fan-out uses Pattern 3 — `spawnAndAwaitChild`
 *     against `IMAGE_WORKFLOW`. `Promise.allSettled` so a single failing
 *     image (or timeout) doesn't kill the rest of the batch.
 *   - The variant-image (shot-grid) fire-and-forget kick remains routed
 *     through `triggerWorkflow('/variant-image', …)` for parity with the
 *     QStash original — the engine registry decides whether that hits CF
 *     or QStash per-deploy. */

import { resolveImageModels } from '@/lib/ai/resolve-image-models';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildElementReferenceImages } from '@/lib/prompts/element-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import { shotVariantDedupId } from '@/lib/workflow/dedup-ids';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { triggerWorkflow } from '@/lib/workflow/client';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { NonRetryableError } from 'cloudflare:workflows';
import type {
  FrameImagesWorkflowInput,
  FrameImagesWorkflowResult,
  ImageWorkflowInput,
  ShotVariantWorkflowInput,
} from '@/lib/workflow/types';
import {
  matchCharactersToScene,
  matchElementsToScene,
  matchLocationsToScene,
} from '@/lib/workflows/scene-matching';
import {
  computeFrameImageSceneHash,
  computeFrameImagesHashFromDto,
  type FrameImageSceneSnapshot,
} from '@/lib/workflows/sheet-snapshots';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'frame-images']);

type ImageChildResult = {
  imageUrl: string;
  frameId?: string;
  sequenceId?: string;
};

export class FrameImagesWorkflow extends OpenStoryWorkflowEntrypoint<FrameImagesWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<FrameImagesWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<FrameImagesWorkflowResult> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;

    // Snapshot validation. The QStash original calls
    // `context.snapshot.validate()` inside a `context.run`; the CF base
    // class has no snapshot extension, so we recompute the DTO hash and
    // compare directly. Top-level throw → `WorkflowValidationError` (the
    // base class re-wraps as CF `NonRetryableError`).
    await step.do('validate-snapshot', async () => {
      if (!input.sceneSnapshots || input.sceneSnapshots.length === 0) {
        // Snapshots are optional — when absent there's nothing to validate.
        return;
      }
      const expected = input.snapshotInputHash ?? '';
      const recomputed = await computeFrameImagesHashFromDto({
        ...input,
        sceneSnapshots: input.sceneSnapshots,
      });
      if (recomputed !== expected) {
        // NonRetryableError (not WorkflowValidationError) because the base
        // class's re-wrap only runs at the runImpl catch boundary; a throw
        // inside step.do gets retried by CF's step machinery first.
        throw new NonRetryableError(
          'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently',
          'WorkflowValidationError'
        );
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

    // Build per-scene character, location, and element maps for reference
    // image lookup. Re-fetch elements from the DB here (rather than relying
    // on the snapshot taken at analyze-script start) — vision analysis for
    // a slow element may have finished during phases 2–3, so re-fetching
    // picks up the fresh description.
    const { sceneCharacterMap, sceneLocationMap, sceneElementMap } =
      await step.do('build-reference-maps', async () => {
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

    // Build a sceneId→snapshot index once so the per-(scene, model) inner
    // loop doesn't repeat O(snapshots) `find` work for every frame × model.
    const sceneSnapshotsById = new Map<string, FrameImageSceneSnapshot>(
      (input.sceneSnapshots ?? []).map((s) => [s.sceneId, s])
    );

    // Pre-compute every (sceneId, model) snapshot hash once and persist via
    // `step.do`. Workflow bodies replay from the top on every step callback,
    // so wrapping in `step.do` snapshots the result — replays just read the
    // persisted Record instead of re-hashing on each callback.
    const snapshotHashKey = (sceneId: string, model: string) =>
      `${sceneId}::${model}`;
    const snapshotHashByKey = await step.do(
      'compute-snapshot-hashes',
      async () => {
        const out: Record<string, string | undefined> = {};
        for (const scene of scenesWithVisualPrompts) {
          const snap = sceneSnapshotsById.get(scene.sceneId);
          for (const model of imageModels) {
            out[snapshotHashKey(scene.sceneId, model)] = snap
              ? await computeFrameImageSceneHash(snap, model, aspectRatio)
              : undefined;
          }
        }
        return out;
      }
    );

    const imageBinding = this.env.IMAGE_WORKFLOW;

    // Fan out one IMAGE_WORKFLOW child per (scene, model). `Promise.allSettled`
    // so a single image timeout / failure doesn't poison the rest of the
    // batch — we surface per-scene failures via WorkflowValidationError below
    // for parity with the QStash version's `result.isFailed` check.
    const sceneResults = await Promise.allSettled(
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

        // Bound to sceneId rather than index so a re-ordered `sceneSnapshots`
        // array (e.g. analyze-script sorts by sceneId; we don't) still maps
        // right.
        const sceneSnapshot = sceneSnapshotsById.get(scene.sceneId);

        // Generate with each selected model in parallel. Each (scene, model)
        // becomes one Pattern 3 child invocation. `Promise.allSettled` here
        // too so one model failure doesn't poison the other models for the
        // same scene.
        const modelResults = await Promise.allSettled(
          imageModels.map(async (model) => {
            const perFrameSnapshotInputHash =
              snapshotHashByKey[snapshotHashKey(scene.sceneId, model)];

            const childBody: ImageWorkflowInput = {
              userId: input.userId,
              teamId: input.teamId,
              prompt: visualPrompt,
              model,
              imageSize,
              aspectRatio,
              numImages: 1,
              frameId: matchedFrame?.frameId,
              sequenceId,
              referenceImages:
                allReferences.length > 0 ? allReferences : undefined,
              sceneSnapshot,
              snapshotInputHash: perFrameSnapshotInputHash,
            };

            // Per-spawn unique IDs. Include the model so the per-(scene,
            // model) fan-out gets distinct CF instance IDs — siblings
            // would otherwise collide on `image:${sequenceId}:${frameId}`
            // (CF instance IDs are global per Worker script).
            const childIdSuffix = matchedFrame?.frameId
              ? `image:${sequenceId ?? 'no-seq'}:${matchedFrame.frameId}:${model}`
              : `image:${sequenceId ?? 'no-seq'}:${scene.sceneId}:${model}`;

            const childOutput = await spawnAndAwaitChild<
              ImageWorkflowInput,
              ImageChildResult
            >(step, {
              binding: imageBinding,
              parentBindingName: 'FRAME_IMAGES_WORKFLOW',
              parentInstanceId,
              childId: childIdSuffix,
              childPayload: childBody,
              spawnStepName: `spawn-image-${scene.sceneId}-${model}`,
              awaitStepName: `await-image-${scene.sceneId}-${model}`,
              timeout: '30 minutes',
            });

            if (!childOutput.imageUrl) {
              throw new WorkflowValidationError(
                `Image generation failed for scene ${scene.sceneId} model ${model}`
              );
            }

            // Trigger variant (shot grid) workflow as a separate top-level
            // run. Fire-and-forget — frame-images shouldn't block on it,
            // since the variant just enriches the frame after the fact and
            // its progress is tracked independently via
            // `frame.variantImageStatus`.
            await step.do(
              `trigger-variant-${scene.sceneId}-${model}`,
              async () => {
                await triggerWorkflow<ShotVariantWorkflowInput>(
                  '/variant-image',
                  {
                    userId: input.userId,
                    teamId: input.teamId,
                    sequenceId,
                    frameId: matchedFrame?.frameId,
                    thumbnailUrl: childOutput.imageUrl,
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
                    retries: 3,
                    retryDelay: 'pow(2, retried) * 1000',
                    // Replay-stable: a retry of this step.do must reuse the
                    // existing variant instance instead of spawning a second
                    // paid job (see dedup-ids.ts).
                    deduplicationId: shotVariantDedupId(
                      parentInstanceId,
                      matchedFrame?.frameId ?? scene.sceneId,
                      model
                    ),
                  }
                );
              }
            );

            return childOutput.imageUrl;
          })
        );

        // Surface per-model failures. The primary (index 0) result is what
        // gets returned as this scene's `imageUrl`; if it failed we throw
        // for parity with the QStash original's `result.isFailed` check.
        // Sibling-model failures are logged but don't block — they're
        // alternates that enrich `frame_variants`, not the primary.
        const primary = modelResults[0];
        if (!primary) {
          throw new WorkflowValidationError(
            `Primary image generation failed for scene ${scene.sceneId}: no models configured`
          );
        }
        if (primary.status === 'rejected') {
          throw new WorkflowValidationError(
            `Primary image generation failed for scene ${scene.sceneId}: ${String(primary.reason)}`
          );
        }
        for (let i = 1; i < modelResults.length; i++) {
          const r = modelResults[i];
          if (r?.status === 'rejected') {
            logger.warn(
              `[FrameImagesWorkflow:cf] Alternate model ${imageModels[i]} failed for scene ${scene.sceneId}:`,
              {
                err: r.reason,
              }
            );
          }
        }
        return primary.value;
      })
    );

    // Collect results ALIGNED to scene order — a rejected scene keeps its
    // slot as `null` rather than being compacted out. Consumers index
    // `imageUrls` by scene position (analyze-script phase 5 pairs
    // `imageUrls[index]` with `completeScenes[index]`), so compaction shifted
    // every later image onto the wrong scene and made the trailing scene
    // throw "has no generated image URL" (June 6 sample-run failure).
    // Rejections get reported but don't kill the workflow, so a single scene
    // with no visual prompt (or a deleted frame mid-flight) can't poison the
    // rest of the batch.
    const imageUrls: (string | null)[] = sceneResults.map((r, i) => {
      if (r.status === 'fulfilled') return r.value;
      const scene = scenesWithVisualPrompts[i];
      logger.error(
        `[FrameImagesWorkflow:cf] Scene ${scene?.sceneId ?? '(unknown)'} failed: ${String(r.reason)}`,
        {
          err: r.reason,
        }
      );
      return null;
    });

    return { imageUrls };
  }

  protected override onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<FrameImagesWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): void {
    const input = event.payload;
    logger.error(
      `[FrameImagesWorkflow:cf] Frame image generation failed for sequence ${input.sequenceId}: ${error}`
    );
  }
}
