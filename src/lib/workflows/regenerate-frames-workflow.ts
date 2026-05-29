/**
 * Cloudflare Workflows port of `regenerateFramesWorkflow`.
 *
 * Wave 3 fan-out leaf: bulk regenerates frame images after a character or
 * location recast. Mirrors the QStash version
 * (`src/lib/workflows/regenerate-frames-workflow.ts`) step for step — same
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
 *     (`image:${sequenceId}:${frameId}`) and a unique event-type qualifier so
 *     siblings cannot match each other's completion events.
 *   - Calls the snapshot DTO computer (`computeRegenerateFramesBatchHash`)
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
  RegenerateFramesWorkflowInput,
  ShotVariantWorkflowInput,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import {
  buildConvergentWrites,
  buildDivergentWrites,
  buildRegenerateFrameSnapshot,
  computeRegenerateFramesBatchHash,
  emitRecastEvent,
} from '@/lib/workflows/regenerate-frames-snapshot';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'regenerate-frames']);

type FrameResult =
  | { frameId: string; success: true; imageUrl: string }
  | { frameId: string; success: false; error: string };

type RegenerateFramesResult = {
  totalFrames: number;
  successCount: number;
  failedFrames: string[];
  divergedFrameIds: string[];
};

type ImageChildOutput = {
  imageUrl: string;
  frameId?: string;
  sequenceId?: string;
};

export class RegenerateFramesWorkflow extends OpenStoryWorkflowEntrypoint<RegenerateFramesWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<RegenerateFramesWorkflowInput>>,
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
    if (!childBinding) {
      throw new WorkflowValidationError(
        '[RegenerateFramesWorkflow:cf] IMAGE_WORKFLOW binding is missing on env; check wrangler.jsonc'
      );
    }

    // Validate the snapshot hash inside the workflow body. Mirrors the QStash
    // `validate-snapshot` step but calls the DTO computer directly because CF
    // has no `context.snapshot.*` extension.
    await step.do('validate-snapshot', async () => {
      const expected = input.snapshotInputHash;
      if (!expected) return;
      const recomputed = await computeRegenerateFramesBatchHash(input);
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
        failedFrames: [],
        divergedFrameIds: [],
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
    // failures become `FrameResult` entries that the reconcile pass below
    // handles individually.
    // ============================================================
    const settled = await Promise.allSettled(
      snapshots.map((snapshot, frameIndex): Promise<FrameResult> => {
        if (!snapshot.imagePrompt) {
          // Per-frame failure — peer frames in the batch should still run.
          return Promise.resolve({
            frameId: snapshot.frameId,
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
          frameId: snapshot.frameId,
          prompt: snapshot.imagePrompt,
          model: imageModel,
          imageSize: aspectRatioToImageSize(aspectRatio),
          numImages: 1,
          referenceImages,
        };

        return spawnAndAwaitChild<ImageWorkflowInput, ImageChildOutput>(step, {
          binding: childBinding,
          parentBindingName: 'REGENERATE_FRAMES_WORKFLOW',
          parentInstanceId,
          childId: `image:${sequenceId}:${snapshot.frameId}`,
          childPayload,
          spawnStepName: `spawn-image-${frameIndex}`,
          awaitStepName: `await-image-${frameIndex}`,
        }).then(
          (body): FrameResult => {
            if (!body.imageUrl) {
              logger.error(
                `[RegenerateFramesWorkflow:cf] Image generation failed frame=${snapshot.frameId} reason=no imageUrl`
              );
              return {
                frameId: snapshot.frameId,
                success: false,
                error: 'Image generation no imageUrl',
              };
            }
            return {
              frameId: snapshot.frameId,
              success: true,
              imageUrl: body.imageUrl,
            };
          },
          (err: unknown): FrameResult => {
            const reason = err instanceof Error ? err.message : String(err);
            logger.error(
              `[RegenerateFramesWorkflow:cf] Image generation failed frame=${snapshot.frameId} reason=${reason}`
            );
            return {
              frameId: snapshot.frameId,
              success: false,
              error: `Image generation failed: ${reason}`,
            };
          }
        );
      })
    );

    // Promise.allSettled with onfulfilled/onrejected mappers above means every
    // entry is a resolved FrameResult. Collect them into the same shape the
    // QStash original produced.
    const imageResults: FrameResult[] = settled.map((outcome, i) => {
      if (outcome.status === 'fulfilled') return outcome.value;
      const snapshot = snapshots[i];
      const reason =
        outcome.reason instanceof Error
          ? outcome.reason.message
          : String(outcome.reason);
      return {
        frameId: snapshot?.frameId ?? `#${i}`,
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
          `reconcile-frame-${result.frameId}`,
          async (): Promise<ReconcileOutcome> => {
            const snapshot = snapshots.find(
              (s) => s.frameId === result.frameId
            );
            if (!snapshot) {
              // Invariant: imageResults is built from snapshots. Permanent
              // (programmer-error) state — surface but don't retry.
              return {
                kind: 'failed',
                error: `imageResults produced frameId=${result.frameId} not in snapshots`,
              };
            }

            const liveFrame = await scopedDb.frames.getById(result.frameId);
            if (!liveFrame) {
              // Frame was deleted mid-flight. The speculative thumbnail was
              // already written by image-workflow, but its row is gone —
              // there's nothing left to reconcile. Skipped, not failed.
              return { kind: 'skipped-deleted' };
            }

            const currentSnapshot = await buildRegenerateFrameSnapshot({
              frame: liveFrame,
              characters: allCharacters,
              locations: allLocations,
              imageModel,
              aspectRatio,
            });

            if (
              currentSnapshot.snapshotInputHash === snapshot.snapshotInputHash
            ) {
              const writes = buildConvergentWrites(snapshot.snapshotInputHash);
              await scopedDb.frames.update(result.frameId, writes.frame);
              const updated =
                await scopedDb.frameVariants.updateByFrameAndModel(
                  result.frameId,
                  'image',
                  imageModel,
                  writes.variant
                );
              if (!updated) {
                return {
                  kind: 'failed',
                  error: `Convergent reconcile: no frame_variants row for frame=${result.frameId} model=${imageModel} — image-workflow's dual-write must run before regenerate-frames reconciles.`,
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
              await scopedDb.frameVariants.getByFrameAndModel(
                result.frameId,
                'image',
                imageModel
              );

            const divergedAt = new Date();
            const writes = buildDivergentWrites(
              snapshot.snapshotInputHash,
              divergedAt
            );

            await scopedDb.frames.update(result.frameId, writes.frame);

            const reverted = await scopedDb.frameVariants.updateByFrameAndModel(
              result.frameId,
              'image',
              imageModel,
              writes.primaryRevert
            );
            if (!reverted) {
              return {
                kind: 'failed',
                error: `Divergent reconcile: no primary frame_variants row to revert for frame=${result.frameId} model=${imageModel} — image-workflow's dual-write must run before regenerate-frames reconciles.`,
              };
            }

            const divergentVariant =
              await scopedDb.frameVariants.insertDivergent({
                frameId: result.frameId,
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
              frameId: result.frameId,
              status: 'pending',
              model: imageModel,
            });

            await channel.emit('generation.stale:detected', {
              entityType: 'frame',
              entityId: result.frameId,
              artifact: 'thumbnail',
              snapshotInputHash: snapshot.snapshotInputHash,
              divergedVariantId: divergentVariant.id,
            });

            logger.info(
              `[RegenerateFramesWorkflow:cf] Diverged frame ${result.frameId}: snapshot=${snapshot.snapshotInputHash.slice(0, 8)} current=${currentSnapshot.snapshotInputHash.slice(0, 8)}`
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

      reconcileOutcomes.set(result.frameId, outcome);
      if (outcome.kind === 'failed') {
        logger.error(
          `[RegenerateFramesWorkflow:cf] Reconcile failed for frame ${result.frameId}: ${outcome.error}`
        );
      } else if (outcome.kind === 'skipped-deleted') {
        logger.warn(
          `[RegenerateFramesWorkflow:cf] Frame ${result.frameId} deleted mid-flight; skipping reconciliation`
        );
      }
    }

    // Single pass over reconcileOutcomes with an exhaustive switch.
    // Adding a new ReconcileOutcome variant fails compile here (the `never`
    // assignment) instead of silently dropping those frames from every tally.
    const convergentFrameIds: string[] = [];
    const divergedFrameIds: string[] = [];
    const skippedDeletedFrameIds: string[] = [];
    const reconcileFailedFrameIds: string[] = [];
    for (const [frameId, outcome] of reconcileOutcomes) {
      switch (outcome.kind) {
        case 'convergent':
          convergentFrameIds.push(frameId);
          break;
        case 'divergent':
          divergedFrameIds.push(frameId);
          break;
        case 'skipped-deleted':
          skippedDeletedFrameIds.push(frameId);
          break;
        case 'failed':
          reconcileFailedFrameIds.push(frameId);
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
      const convergentFrameIdSet = new Set(convergentFrameIds);
      const convergent = imageResults.filter(
        (r): r is Extract<FrameResult, { success: true }> =>
          r.success && convergentFrameIdSet.has(r.frameId)
      );

      await Promise.all(
        convergent.map(async (result) => {
          const snapshot = snapshots.find((s) => s.frameId === result.frameId);
          if (!snapshot) return;

          await triggerWorkflow<ShotVariantWorkflowInput>(
            '/variant-image',
            {
              userId: input.userId,
              teamId,
              sequenceId,
              frameId: result.frameId,
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
              deduplicationId: `variant-image-${result.frameId}-${imageModel}-${snapshot.snapshotInputHash.slice(0, 16)}`,
            }
          );
        })
      );
    });

    // Success = frames whose primary write was reconciled (convergent kept
    // the primary; divergent saved an alternate). Image-generation failures,
    // deleted-mid-flight skips, and reconcile failures don't count.
    const imageFailedFrameIds = imageResults
      .filter((r) => !r.success)
      .map((r) => r.frameId);

    const failedFrames = [...imageFailedFrameIds, ...reconcileFailedFrameIds];
    const successCount = convergentFrameIds.length + divergedFrameIds.length;

    await step.do('emit-complete', async () => {
      await emitRecastEvent({
        kind: triggerKind,
        event: 'complete',
        sequenceId,
        triggerId,
        successCount,
        failedCount: failedFrames.length,
      });
    });

    logger.info(
      `[RegenerateFramesWorkflow:cf] Completed: ${successCount} success, ${failedFrames.length} failed, ${divergedFrameIds.length} diverged, ${skippedDeletedFrameIds.length} skipped-deleted`
    );

    return {
      totalFrames: snapshots.length,
      successCount,
      failedFrames,
      divergedFrameIds,
    };
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<RegenerateFramesWorkflowInput>>;
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
