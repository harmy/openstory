/**
 * Cloudflare Workflows port of `regenerateFramesWorkflow`.
 *
 * Wave 3 fan-out leaf: bulk regenerates frame images after a character or
 * location recast. Mirrors the QStash version
 * (`src/lib/workflows/regenerate-shots-workflow.ts`) step for step — same
 * step names, same control flow, same side effects. The only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`
 *     and the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`.
 *   - The Promise.all over `context.invoke('image', ...)` becomes
 *     `Promise.all` spawn + `Promise.allSettled` await of
 *     `spawnAndAwaitChild` (Pattern 3 fan-out helpers in
 *     `await-child.ts`). Each child gets a deterministic instance ID
 *     (`image:${sequenceId}:${shotId}`) and a unique event-type qualifier so
 *     siblings cannot match each other's completion events.
 *   - Calls the snapshot DTO computer (`computeRegenerateShotsBatchHash`)
 *     directly inside `step.do('validate-snapshot')` instead of going
 *     through the `context.snapshot.*` extension.
 *   - `failureFunction` → `onFailure`. */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import { getGenerationChannel } from '@/lib/realtime';
import { triggerWorkflow } from '@/lib/workflow/client';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type {
  ImageWorkflowInput,
  RegenerateShotsWorkflowInput,
  ShotVariantWorkflowInput,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  buildConvergentWrites,
  buildDivergentWrites,
  buildRegenerateShotSnapshot,
  computeRegenerateShotsBatchHash,
  emitRecastEvent,
} from '@/lib/workflows/regenerate-shots-snapshot';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'regenerate-shots']);

type ShotResult =
  | { shotId: string; success: true; imageUrl: string }
  | { shotId: string; success: false; error: string };

type RegenerateFramesResult = {
  totalFrames: number;
  successCount: number;
  failedShots: string[];
  divergedShotIds: string[];
};

type ImageChildOutput = {
  imageUrl: string;
  shotId?: string;
  sequenceId?: string;
};

export class RegenerateShotsWorkflow extends OpenStoryWorkflowEntrypoint<RegenerateShotsWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<RegenerateShotsWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<RegenerateFramesResult> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const { sequenceId, teamId, triggerKind, triggerId } = input;
    const label = buildWorkflowLabel(sequenceId);

    // ============================================================
    // Top-level validation (re-throws as NonRetryableError via the base
    // class's WorkflowValidationError re-wrap). Inside step.do we use
    // CF's NonRetryableError directly so the step machinery doesn't burn
    // its retry budget on programmer errors.
    // ============================================================
    if (!sequenceId) {
      throw new WorkflowValidationError('Sequence ID is required');
    }

    const childBinding = this.env.IMAGE_WORKFLOW;

    // Validate the snapshot hash inside the workflow body. Mirrors the QStash
    // `validate-snapshot` step but calls the DTO computer directly because CF
    // has no `context.snapshot.*` extension.
    await step.do('validate-snapshot', async () => {
      const expected = input.snapshotInputHash;
      if (!expected) return;
      const recomputed = await computeRegenerateShotsBatchHash(input);
      if (recomputed !== expected) {
        throw new NonRetryableError(
          'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently',
          'WorkflowValidationError'
        );
      }
    });

    const snapshots = input.frameSnapshots;
    if (snapshots.length === 0) {
      return {
        totalFrames: 0,
        successCount: 0,
        failedShots: [],
        divergedShotIds: [],
      };
    }

    const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
    const aspectRatio = input.aspectRatio;

    await step.do('emit-start', async () => {
      await emitRecastEvent({
        kind: triggerKind,
        event: 'start',
        sequenceId,
        triggerId,
        frameCount: snapshots.length,
      });
    });

    // ============================================================
    // PHASE: Per-frame image regeneration — fan out via Pattern 3.
    // Use Promise.allSettled so a single child timeout / failure does not
    // kill the parent — each sibling resolves independently, and per-frame
    // failures become `ShotResult` entries that the reconcile pass below
    // handles individually.
    // ============================================================
    const settled = await Promise.allSettled(
      snapshots.map((snapshot, shotIndex): Promise<ShotResult> => {
        if (!snapshot.imagePrompt) {
          // Per-frame failure — peer frames in the batch should still run.
          return Promise.resolve({
            shotId: snapshot.shotId,
            success: false,
            error: 'no image prompt',
          });
        }

        const referenceImages = [
          ...snapshot.characterRefs,
          ...snapshot.locationRefs,
        ];

        const childPayload: ImageWorkflowInput = {
          userId: input.userId,
          teamId,
          sequenceId,
          shotId: snapshot.shotId,
          prompt: snapshot.imagePrompt,
          model: imageModel,
          imageSize: aspectRatioToImageSize(aspectRatio),
          numImages: 1,
          referenceImages,
        };

        return spawnAndAwaitChild<ImageWorkflowInput, ImageChildOutput>(step, {
          binding: childBinding,
          parentBindingName: 'REGENERATE_SHOTS_WORKFLOW',
          parentInstanceId,
          childId: `image:${sequenceId}:${snapshot.shotId}`,
          childPayload,
          spawnStepName: `spawn-image-${shotIndex}`,
          awaitStepName: `await-image-${shotIndex}`,
        }).then(
          (body): ShotResult => {
            if (!body.imageUrl) {
              logger.error(
                `[RegenerateFramesWorkflow:cf] Image generation failed shot=${snapshot.shotId} reason=no imageUrl`
              );
              return {
                shotId: snapshot.shotId,
                success: false,
                error: 'Image generation no imageUrl',
              };
            }
            return {
              shotId: snapshot.shotId,
              success: true,
              imageUrl: body.imageUrl,
            };
          },
          (err: unknown): ShotResult => {
            const reason = err instanceof Error ? err.message : String(err);
            logger.error(
              `[RegenerateFramesWorkflow:cf] Image generation failed shot=${snapshot.shotId} reason=${reason}`
            );
            return {
              shotId: snapshot.shotId,
              success: false,
              error: `Image generation failed: ${reason}`,
            };
          }
        );
      })
    );

    // Promise.allSettled with onfulfilled/onrejected mappers above means every
    // entry is a resolved ShotResult. Collect them into the same shape the
    // QStash original produced.
    const imageResults: ShotResult[] = settled.map((outcome, i) => {
      if (outcome.status === 'fulfilled') return outcome.value;
      const snapshot = snapshots[i];
      const reason =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      return {
        shotId: snapshot?.shotId ?? `#${i}`,
        success: false,
        error: `Image generation failed: ${reason}`,
      };
    });

    // Shared batch reads — pulled out of the per-frame loop so each frame's
    // reconcile step is independent (one frame's DB blip can't poison the
    // batch's character/location lookup).
    const allCharacters = await step.do('load-characters', () =>
      scopedDb.characters.listWithSheets(sequenceId)
    );
    const allLocations = await step.do('load-locations', () =>
      scopedDb.sequenceLocations.listWithReferences(sequenceId)
    );
    const allElements = await step.do('load-elements', () =>
      scopedDb.sequenceElements.list(sequenceId)
    );

    type ReconcileOutcome =
      | { kind: 'convergent' }
      | { kind: 'divergent' }
      | { kind: 'skipped-deleted' }
      | { kind: 'failed'; error: string };

    const reconcileOutcomes = new Map<string, ReconcileOutcome>();

    // Per-frame `step.do` so one frame's failure does not abort siblings.
    // Known-permanent states return tagged outcomes (no retries burned).
    // Unknown throws propagate inside the step so CF applies its retry
    // policy; only after retries exhaust does the outer catch convert to a
    // `failed` outcome.
    for (const result of imageResults) {
      if (!result.success) continue;

      let outcome: ReconcileOutcome;
      try {
        outcome = await step.do(
          `reconcile-frame-${result.shotId}`,
          async (): Promise<ReconcileOutcome> => {
            const snapshot = snapshots.find((s) => s.shotId === result.shotId);
            if (!snapshot) {
              // Invariant: imageResults is built from snapshots. Permanent
              // (programmer-error) state — surface but don't retry.
              return {
                kind: 'failed',
                error: `imageResults produced shotId=${result.shotId} not in snapshots`,
              };
            }

            const liveFrame = await scopedDb.shots.getById(result.shotId);
            if (!liveFrame) {
              // Frame was deleted mid-flight. The speculative thumbnail was
              // already written by image-workflow, but its row is gone —
              // there's nothing left to reconcile. Skipped, not failed.
              return { kind: 'skipped-deleted' };
            }

            const currentSnapshot = await buildRegenerateShotSnapshot({
              frame: liveFrame,
              characters: allCharacters,
              locations: allLocations,
              elements: allElements,
              imageModel,
              aspectRatio,
            });

            if (
              currentSnapshot.snapshotInputHash === snapshot.snapshotInputHash
            ) {
              const writes = buildConvergentWrites(snapshot.snapshotInputHash);
              await scopedDb.shots.update(result.shotId, writes.frame);
              const updated = await scopedDb.shotVariants.updateByFrameAndModel(
                result.shotId,
                'image',
                imageModel,
                writes.variant
              );
              if (!updated) {
                return {
                  kind: 'failed',
                  error: `Convergent reconcile: no frame_variants row for frame=${result.shotId} model=${imageModel} — image-workflow's dual-write must run before regenerate-shots reconciles.`,
                };
              }
              return { kind: 'convergent' };
            }

            // Divergent path. Read the primary variant first so its R2-tracked
            // storage fields (storagePath/previewUrl/shotVariantUrl) carry
            // forward to the divergent alternate — clearing the primary
            // without copying would leave the speculative R2 object untracked.
            //
            // Write order (revert-then-insert):
            //   1. Revert the speculative primary thumbnail on the frame row.
            //   2. Revert the speculative URL on the primary variant row so
            //      the primary slot stops pointing at diverged work.
            //   3. Insert (or no-op on retry) a divergent alternate row
            //      preserving the diverged result for comparison/promotion.
            // Steps 1 and 2 must precede 3: if step 3 fails, the user keeps
            // ownership of their live edits (no stale primary), at the cost
            // of losing the diverged result. The inverse would leave the UI
            // saying "diverged" while the speculative thumbnail still owned
            // the primary.
            const primaryVariant =
              await scopedDb.shotVariants.getByFrameAndModel(
                result.shotId,
                'image',
                imageModel
              );

            const divergedAt = new Date();
            const writes = buildDivergentWrites(
              snapshot.snapshotInputHash,
              divergedAt
            );

            await scopedDb.shots.update(result.shotId, writes.frame);

            const reverted = await scopedDb.shotVariants.updateByFrameAndModel(
              result.shotId,
              'image',
              imageModel,
              writes.primaryRevert
            );
            if (!reverted) {
              return {
                kind: 'failed',
                error: `Divergent reconcile: no primary frame_variants row to revert for frame=${result.shotId} model=${imageModel} — image-workflow's dual-write must run before regenerate-shots reconciles.`,
              };
            }

            const divergentVariant =
              await scopedDb.shotVariants.insertDivergent({
                shotId: result.shotId,
                sequenceId,
                variantType: 'image',
                model: imageModel,
                url: result.imageUrl,
                storagePath: primaryVariant?.storagePath ?? null,
                previewUrl: primaryVariant?.previewUrl ?? null,
                shotVariantUrl: primaryVariant?.shotVariantUrl ?? null,
                shotVariantPath: primaryVariant?.shotVariantPath ?? null,
                ...writes.divergentRow,
              });

            const channel = getGenerationChannel(sequenceId);
            await channel.emit('generation.image:progress', {
              shotId: result.shotId,
              status: 'pending',
              model: imageModel,
            });

            await channel.emit('generation.stale:detected', {
              entityType: 'shot',
              entityId: result.shotId,
              artifact: 'thumbnail',
              snapshotInputHash: snapshot.snapshotInputHash,
              divergedVariantId: divergentVariant.id,
            });

            logger.info(
              `[RegenerateFramesWorkflow:cf] Diverged frame ${result.shotId}: snapshot=${snapshot.snapshotInputHash.slice(0, 8)} current=${currentSnapshot.snapshotInputHash.slice(0, 8)}`
            );

            return { kind: 'divergent' };
          }
        );
      } catch (err) {
        // CF exhausted retries on this frame's step. Capture as a failed
        // outcome so siblings still reconcile.
        outcome = {
          kind: 'failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }

      reconcileOutcomes.set(result.shotId, outcome);
      if (outcome.kind === 'failed') {
        logger.error(
          `[RegenerateFramesWorkflow:cf] Reconcile failed for frame ${result.shotId}: ${outcome.error}`
        );
      } else if (outcome.kind === 'skipped-deleted') {
        logger.warn(
          `[RegenerateFramesWorkflow:cf] Frame ${result.shotId} deleted mid-flight; skipping reconciliation`
        );
      }
    }

    // Single pass over reconcileOutcomes with an exhaustive switch.
    // Adding a new ReconcileOutcome variant fails compile here (the `never`
    // assignment) instead of silently dropping those frames from every tally.
    const convergentShotIds: string[] = [];
    const divergedShotIds: string[] = [];
    const skippedDeletedShotIds: string[] = [];
    const reconcileFailedShotIds: string[] = [];
    for (const [shotId, outcome] of reconcileOutcomes) {
      switch (outcome.kind) {
        case 'convergent':
          convergentShotIds.push(shotId);
          break;
        case 'divergent':
          divergedShotIds.push(shotId);
          break;
        case 'skipped-deleted':
          skippedDeletedShotIds.push(shotId);
          break;
        case 'failed':
          reconcileFailedShotIds.push(shotId);
          break;
        default: {
          const _exhaustive: never = outcome;
          throw new Error(
            `[RegenerateFramesWorkflow:cf] Unhandled ReconcileOutcome: ${JSON.stringify(_exhaustive)}`
          );
        }
      }
    }

    // Shot variants (the 3x3 grid in the Variants tab) are derived from the
    // primary thumbnail. Image-workflow regenerated the primary; without this
    // step the grid keeps showing the pre-recast character. Fire-and-forget:
    // each variant runs as its own workflow so this batch returns as soon as
    // primaries are reconciled. Only fan out for convergent frames — divergent
    // frames preserve the user's live primary, so their existing shot
    // variants are still correct.
    await step.do('trigger-variant-regen', async () => {
      const convergentShotIdSet = new Set(convergentShotIds);
      const convergent = imageResults.filter(
        (r): r is Extract<ShotResult, { success: true }> =>
          r.success && convergentShotIdSet.has(r.shotId)
      );

      await Promise.all(
        convergent.map(async (result) => {
          const snapshot = snapshots.find((s) => s.shotId === result.shotId);
          if (!snapshot) return;

          await triggerWorkflow<ShotVariantWorkflowInput>(
            '/variant-image',
            {
              userId: input.userId,
              teamId,
              sequenceId,
              shotId: result.shotId,
              thumbnailUrl: result.imageUrl,
              scenePrompt: snapshot.imagePrompt,
              characterReferences:
                snapshot.characterRefs.length > 0
                  ? snapshot.characterRefs
                  : undefined,
              locationReferences:
                snapshot.locationRefs.length > 0
                  ? snapshot.locationRefs
                  : undefined,
              aspectRatio,
              model: imageModel,
            },
            {
              label,
              // Dedupe: a retry of this step.do mustn't re-fire variants.
              deduplicationId: `variant-image-${result.shotId}-${imageModel}-${snapshot.snapshotInputHash.slice(0, 16)}`,
            }
          );
        })
      );
    });

    // Success = frames whose primary write was reconciled (convergent kept
    // the primary; divergent saved an alternate). Image-generation failures,
    // deleted-mid-flight skips, and reconcile failures don't count.
    const imageFailedShotIds = imageResults
      .filter((r) => !r.success)
      .map((r) => r.shotId);

    const failedShots = [...imageFailedShotIds, ...reconcileFailedShotIds];
    const successCount = convergentShotIds.length + divergedShotIds.length;

    await step.do('emit-complete', async () => {
      await emitRecastEvent({
        kind: triggerKind,
        event: 'complete',
        sequenceId,
        triggerId,
        successCount,
        failedCount: failedShots.length,
      });
    });

    logger.info(
      `[RegenerateFramesWorkflow:cf] Completed: ${successCount} success, ${failedShots.length} failed, ${divergedShotIds.length} diverged, ${skippedDeletedShotIds.length} skipped-deleted`
    );

    return {
      totalFrames: snapshots.length,
      successCount,
      failedShots,
      divergedShotIds,
    };
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<RegenerateShotsWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;

    if (input.sequenceId) {
      await emitRecastEvent({
        kind: input.triggerKind,
        event: 'failed',
        sequenceId: input.sequenceId,
        triggerId: input.triggerId,
        error,
      });
    }

    logger.error(
      `[RegenerateFramesWorkflow:cf] Frame regeneration failed: ${error}`
    );
  }
}
