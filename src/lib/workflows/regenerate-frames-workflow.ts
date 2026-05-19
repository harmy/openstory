/**
 * Regenerate Frames Workflow
 *
 * Bulk regenerates frame images after character/location recast. Operates
 * entirely from an inlined snapshot DTO assembled at trigger time — no live
 * mutable reads inside `context.run`.
 *
 * Convergent path (current inputs match snapshot): records `thumbnailInputHash`
 * on the frame and the matching `frame_variants` row alongside the primary
 * write that `image-workflow` already performed.
 * Divergent path (something changed mid-flight): leaves the primary frame
 * artifact alone and rewrites the per-model `frame_variants` row as a
 * divergence (input_hash + diverged_at) so the UI can offer it as an
 * alternative without disturbing the user's live thumbnail.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md.
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import { getGenerationChannel } from '@/lib/realtime';
import { triggerWorkflow } from '@/lib/workflow/client';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  RegenerateFramesWorkflowInput,
  ShotVariantWorkflowInput,
} from '@/lib/workflow/types';
import { generateImageWorkflow } from './image-workflow';
import {
  buildConvergentWrites,
  buildDivergentWrites,
  buildRegenerateFrameSnapshot,
  computeRegenerateFramesBatchHash,
  emitRecastEvent,
} from './regenerate-frames-snapshot';

type FrameResult =
  | { frameId: string; success: true; imageUrl: string }
  | { frameId: string; success: false; error: string };

type RegenerateFramesResult = {
  totalFrames: number;
  successCount: number;
  failedFrames: string[];
  divergedFrameIds: string[];
};

export const regenerateFramesWorkflow = createScopedWorkflow<
  RegenerateFramesWorkflowInput,
  RegenerateFramesResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const { sequenceId, teamId, triggerKind, triggerId } = input;
    const label = buildWorkflowLabel(sequenceId);

    if (!sequenceId) {
      throw new WorkflowValidationError('Sequence ID is required');
    }

    // Validate the snapshot hash inside the workflow body. Upstash swallows
    // runStarted-middleware throws to console.error, so the only place a
    // tampered payload actually halts the run is inside `context.run`, where
    // the throw propagates to QStash and triggers the failureFunction.
    await context.run('validate-snapshot', async () => {
      if (context.snapshot) {
        await context.snapshot.validate();
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

    await context.run('emit-start', async () => {
      await emitRecastEvent({
        kind: triggerKind,
        event: 'start',
        sequenceId,
        triggerId,
        frameCount: snapshots.length,
      });
    });

    const imageResults: FrameResult[] = await Promise.all(
      snapshots.map(async (snapshot): Promise<FrameResult> => {
        if (!snapshot.imagePrompt) {
          // Per-frame failure — peer frames in the batch should still run.
          return {
            frameId: snapshot.frameId,
            success: false,
            error: 'no image prompt',
          };
        }

        const referenceImages = [
          ...snapshot.characterRefs,
          ...snapshot.locationRefs,
        ];

        const { body, isFailed, isCanceled } = await context.invoke('image', {
          workflow: generateImageWorkflow,
          label,
          body: {
            userId: input.userId,
            teamId,
            sequenceId,
            frameId: snapshot.frameId,
            prompt: snapshot.imagePrompt,
            model: imageModel,
            imageSize: aspectRatioToImageSize(aspectRatio),
            numImages: 1,
            referenceImages,
          },
          retries: 3,
          retryDelay: 'pow(2, retried) * 1000',
        });

        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        if (isFailed || isCanceled || !body?.imageUrl) {
          const reason = isCanceled
            ? 'canceled'
            : isFailed
              ? 'failed'
              : 'no imageUrl';
          console.error(
            '[RegenerateFramesWorkflow]',
            `Image generation failed frame=${snapshot.frameId} reason=${reason}`
          );
          return {
            frameId: snapshot.frameId,
            success: false,
            error: `Image generation ${reason}`,
          };
        }

        return {
          frameId: snapshot.frameId,
          success: true,
          imageUrl: body.imageUrl,
        };
      })
    );

    // Shared batch reads — pulled out of the per-frame loop so each frame's
    // reconcile step is independent (one frame's DB blip can't poison the
    // batch's character/location lookup).
    const allCharacters = await context.run('load-characters', () =>
      scopedDb.characters.listWithSheets(sequenceId)
    );
    const allLocations = await context.run('load-locations', () =>
      scopedDb.sequenceLocations.listWithReferences(sequenceId)
    );

    type ReconcileOutcome =
      | { kind: 'convergent' }
      | { kind: 'divergent' }
      | { kind: 'skipped-deleted' }
      | { kind: 'failed'; error: string };

    const reconcileOutcomes = new Map<string, ReconcileOutcome>();

    // Per-frame `context.run` so one frame's failure does not abort siblings.
    // Known-permanent states return tagged outcomes (no retries burned).
    // Unknown throws propagate inside the step so QStash applies its retry
    // policy; only after retries exhaust does the outer catch convert to a
    // `failed` outcome.
    for (const result of imageResults) {
      if (!result.success) continue;

      let outcome: ReconcileOutcome;
      try {
        outcome = await context.run(
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

            console.log(
              '[RegenerateFramesWorkflow]',
              `Diverged frame ${result.frameId}: snapshot=${snapshot.snapshotInputHash.slice(0, 8)} current=${currentSnapshot.snapshotInputHash.slice(0, 8)}`
            );

            return { kind: 'divergent' };
          }
        );
      } catch (err) {
        // QStash exhausted retries on this frame's step. Capture as a failed
        // outcome so siblings still reconcile.
        outcome = {
          kind: 'failed',
          error: err instanceof Error ? err.message : String(err),
        };
      }

      reconcileOutcomes.set(result.frameId, outcome);
      if (outcome.kind === 'failed') {
        console.error(
          '[RegenerateFramesWorkflow]',
          `Reconcile failed for frame ${result.frameId}: ${outcome.error}`
        );
      } else if (outcome.kind === 'skipped-deleted') {
        console.warn(
          '[RegenerateFramesWorkflow]',
          `Frame ${result.frameId} deleted mid-flight; skipping reconciliation`
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
            `[RegenerateFramesWorkflow] Unhandled ReconcileOutcome: ${JSON.stringify(_exhaustive)}`
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
    await context.run('trigger-variant-regen', async () => {
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
              // Dedupe: a retry of this context.run mustn't re-fire variants.
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

    await context.run('emit-complete', async () => {
      await emitRecastEvent({
        kind: triggerKind,
        event: 'complete',
        sequenceId,
        triggerId,
        successCount,
        failedCount: failedFrames.length,
      });
    });

    console.log(
      '[RegenerateFramesWorkflow]',
      `Completed: ${successCount} success, ${failedFrames.length} failed, ${divergedFrameIds.length} diverged, ${skippedDeletedFrameIds.length} skipped-deleted`
    );

    return {
      totalFrames: snapshots.length,
      successCount,
      failedFrames,
      divergedFrameIds,
    };
  },
  {
    failureFunction: async ({ context, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);

      if (input.sequenceId) {
        await emitRecastEvent({
          kind: input.triggerKind,
          event: 'failed',
          sequenceId: input.sequenceId,
          triggerId: input.triggerId,
          error,
        });
      }

      console.error(
        '[RegenerateFramesWorkflow]',
        `Frame regeneration failed: ${error}`
      );

      return `Frame regeneration failed: ${error}`;
    },
    snapshot: {
      computeFromDto: (input) => computeRegenerateFramesBatchHash(input),
      computeCurrent: async (input, scopedDb) => {
        if (!input.sequenceId) {
          throw new WorkflowValidationError(
            'Sequence ID is required for snapshot computation'
          );
        }
        const characters = await scopedDb.characters.listWithSheets(
          input.sequenceId
        );
        const locations = await scopedDb.sequenceLocations.listWithReferences(
          input.sequenceId
        );
        const frames = await scopedDb.frames.getByIds(input.frameIds);
        const aspectRatio = input.aspectRatio;
        const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
        const fresh = await Promise.all(
          frames.map((frame) =>
            buildRegenerateFrameSnapshot({
              frame,
              characters,
              locations,
              imageModel,
              aspectRatio,
            })
          )
        );
        return computeRegenerateFramesBatchHash({
          ...input,
          frameSnapshots: fresh,
        });
      },
    },
  }
);
