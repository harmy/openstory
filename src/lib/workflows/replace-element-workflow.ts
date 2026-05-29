/**
 * Cloudflare Workflows port of `replaceElementWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/replace-element-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - The vision call inlines into a single `describe-new-element` step
 *     instead of invoking the `element-vision` child workflow — matches the
 *     QStash original, which also runs vision in-process here. The
 *     `ElementVisionWorkflow` child is exercised by *other* trigger paths.
 *   - Per-frame fan-out uses `spawnAndAwaitChild` (Pattern 3) to invoke
 *     `ImageWorkflow` for each affected frame, with `Promise.all` to spawn
 *     in parallel and `Promise.allSettled` to gather results so a single
 *     timed-out child cannot tank the rest of the batch.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId` (not needed by this workflow, but included
 *     here for parity with other CF ports). */

import { describeElementImage } from '@/lib/ai/element-vision';
import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  safeImageToVideoModel,
  safeTextToImageModel,
  supportsReferenceImages,
} from '@/lib/ai/models';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import type { ElementVisionStatus, Frame } from '@/lib/db/schema';
import { resolveMotionPrompt } from '@/lib/motion/resolve-motion-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type {
  ImageWorkflowInput,
  MotionWorkflowInput,
  ReplaceElementWorkflowInput,
  ReplaceElementWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'replace-element']);

// `REPLACE_ELEMENT_WORKFLOW` is declared on `CloudflareEnv` (see
// `src/lib/workflow/types.ts`) and wired through `wrangler.jsonc` in the
// follow-on infra PR. The runtime lookup in `notifyParent` /
// `notifyParentOfFailure` only fires if this workflow itself is spawned as a
// child (it's a top-level orchestrator today, so `_parent` is always
// undefined and the constant is dormant).
const PARENT_BINDING_NAME =
  'REPLACE_ELEMENT_WORKFLOW' as const satisfies Parameters<
    typeof spawnAndAwaitChild
  >[1]['parentBindingName'];

type ImageChildResult = {
  imageUrl: string;
  frameId?: string;
  sequenceId?: string;
};

type MotionChildResult = {
  videoUrl: string;
  duration: number;
};

export type FrameResult =
  | { frameId: string; success: true; imageUrl: string }
  | { frameId: string; success: false; error: string };

type BatchOutcome =
  | { kind: 'complete'; successCount: number; failedCount: number }
  | { kind: 'fail'; sampleReason: string; total: number };

/**
 * Pure decision: given per-frame results, should the workflow emit `:complete`
 * or throw to trigger the base class's `onFailure` hook? Skipped-deleted
 * frames never enter `results` so they don't count against the success floor.
 */
export function decideBatchOutcome(results: FrameResult[]): BatchOutcome {
  const successCount = results.filter((r) => r.success).length;
  const failedCount = results.length - successCount;
  if (results.length === 0) {
    return { kind: 'complete', successCount: 0, failedCount: 0 };
  }
  if (successCount === 0) {
    const firstFailure = results.find(
      (r): r is Extract<FrameResult, { success: false }> => !r.success
    );
    const sampleReason = firstFailure?.error ?? 'image edit failed';
    return { kind: 'fail', sampleReason, total: results.length };
  }
  return { kind: 'complete', successCount, failedCount };
}

/**
 * Pure decision: when `onFailure` fires, should the element's `visionStatus`
 * be downgraded to `'failed'`? Only when vision was still in flight — if
 * vision already succeeded, the failure was in a per-frame edit and
 * downgrading would mislead the element card into showing "vision failed".
 */
export function shouldDowngradeVisionOnFailure(
  current: ElementVisionStatus
): boolean {
  return current !== 'completed';
}

/**
 * Best-effort string extraction from a `Promise.allSettled` rejection reason.
 * Errors thrown by application code are usually `Error`, but third-party SDKs
 * and async helpers can reject with strings, plain objects, or
 * DOMException-like values; serializing those preserves the production trail
 * instead of collapsing to a literal `'unknown'`.
 */
export function rejectionReasonMessage(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  if (typeof reason === 'string') return reason;
  try {
    const json = JSON.stringify(reason);
    if (json && json !== '{}') return json;
  } catch {
    // Circular references etc. fall through to the typeof tag.
  }
  return `non-error rejection (${typeof reason})`;
}

/**
 * Pure conversion of a `Promise.allSettled` entry into a `FrameResult`.
 * Fulfilled entries pass through; rejected entries become a failure result
 * tagged with `fallbackFrameId` (the frame whose edit was awaited at this
 * index) or `'unknown'` when that lookup came back empty.
 */
export function settledToResult(
  settled: PromiseSettledResult<FrameResult>,
  fallbackFrameId: string | undefined
): FrameResult {
  if (settled.status === 'fulfilled') return settled.value;
  return {
    frameId: fallbackFrameId ?? 'unknown',
    success: false,
    error: rejectionReasonMessage(settled.reason),
  };
}

export function buildEditPrompt(args: {
  token: string;
  newDescription: string;
  previousDescription: string | null;
}): string {
  const previous = args.previousDescription
    ? ` (previously: ${args.previousDescription})`
    : '';
  return [
    `Edit the PRIMARY SOURCE image to replace the existing ${args.token} element${previous} with the new version shown in the ELEMENT REF image.`,
    `Render the new ${args.token} naturally where the old one appeared, matching scale, perspective, lighting, and occlusion of the original placement.`,
    `Keep all other content — characters, environment, framing, camera angle, color grading, and composition — exactly as they appear in the PRIMARY SOURCE. Only the ${args.token} element should change.`,
    args.newDescription
      ? `New element description: ${args.newDescription}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Emit a realtime event without letting transient Redis failures take down a
 * successful generation. The element card polls for the row's vision status,
 * so a dropped event degrades UX (no toast) but never blocks completion.
 */
async function safeEmit(
  sequenceId: string,
  label: string,
  fn: () => Promise<unknown> | null
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    logger.error(
      `[ReplaceElementWorkflow:cf] emit ${label} for ${sequenceId} failed:`,
      {
        e,
      }
    );
  }
}

export class ReplaceElementWorkflow extends OpenStoryWorkflowEntrypoint<ReplaceElementWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<ReplaceElementWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<ReplaceElementWorkflowResult> {
    const input = event.payload;
    const { sequenceId, elementId, affectedFrameIds, newImageUrl } = input;
    let token = input.token;

    logger.info(
      `[ReplaceElementWorkflow:cf] Starting replace for element ${token} (${elementId}) — ${affectedFrameIds.length} affected frames`
    );

    // Fires before vision so subscribers see the full lifecycle even if
    // vision throws.
    await step.do('emit-start', () =>
      safeEmit(sequenceId, 'start', () =>
        getGenerationChannel(sequenceId).emit(
          'generation.replace-element:start',
          { elementId, frameCount: affectedFrameIds.length }
        )
      )
    );

    const visionResult = await step.do('describe-new-element', async () => {
      await scopedDb.sequenceElements.updateVisionStatus(
        elementId,
        'analyzing'
      );
      const openRouterApiKeyInfo =
        await scopedDb.apiKeys.resolveKey('openrouter');
      const result = await describeElementImage({
        imageUrl: newImageUrl,
        filename: input.newFilename,
        openRouterApiKey: openRouterApiKeyInfo.key,
      });
      await scopedDb.sequenceElements.updateVisionResult(
        elementId,
        result.description,
        result.consistencyTag
      );
      return result;
    });

    // Vision-driven auto-rename: if the new image suggests a meaningfully
    // different identifier AND that identifier isn't taken, cascade the
    // rename through script + frames before the edits so the rewritten
    // prompts/extracts land on the new token rather than the stale one.
    let renamedTo: string | undefined;
    if (visionResult.suggestedToken !== token) {
      const newToken = await step.do('auto-rename-token', async () => {
        const taken = await scopedDb.sequenceElements.isTokenTaken(
          sequenceId,
          visionResult.suggestedToken,
          elementId
        );
        if (taken) return null;
        const result = await scopedDb.sequenceElements.cascadeRename({
          sequenceId,
          elementId,
          oldToken: token,
          newToken: visionResult.suggestedToken,
        });
        return result.element.token;
      });
      if (newToken && newToken !== token) {
        renamedTo = newToken;
        token = newToken;
      }
    }

    if (affectedFrameIds.length === 0) {
      await step.do('emit-complete-empty', () =>
        safeEmit(sequenceId, 'complete-empty', () =>
          getGenerationChannel(sequenceId).emit(
            'generation.replace-element:complete',
            { elementId, successCount: 0, failedCount: 0, renamedTo }
          )
        )
      );
      return {
        elementId,
        successCount: 0,
        failedCount: 0,
      };
    }

    const sequence = await step.do('load-sequence', () =>
      scopedDb.sequences.getById(sequenceId)
    );
    if (!sequence) {
      throw new NonRetryableError(
        `[ReplaceElementWorkflow:cf] Sequence ${sequenceId} not found`,
        'WorkflowValidationError'
      );
    }

    const aspectRatio = sequence.aspectRatio;
    const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;

    // Frames captured at trigger time may have been deleted mid-flight. Treat
    // missing frames as skipped rather than aborting the whole batch.
    const liveFrames = await step.do('load-frames', () =>
      scopedDb.frames.getByIds(affectedFrameIds)
    );
    const liveFrameIds = new Set(liveFrames.map((f) => f.id));
    const skippedDeletedFrameIds = affectedFrameIds.filter(
      (id) => !liveFrameIds.has(id)
    );

    // Flip every affected frame to `generating` and emit progress events
    // BEFORE fanning out per-frame edits. Otherwise the user can navigate to
    // a scene during the vision phase and see stale "completed" thumbnails —
    // the image-workflow's own set-generating-status step runs too late to
    // cover that window. Same upfront flip for videos: any frame with a
    // prior video will be regenerated, so its video tile should already read
    // as in-flight.
    await step.do('mark-frames-generating', async () => {
      for (const frame of liveFrames) {
        const updates: Record<string, unknown> = {};
        if (frame.thumbnailUrl) {
          updates.thumbnailStatus = 'generating';
          updates.thumbnailError = null;
        }
        if (frame.videoUrl) {
          updates.videoStatus = 'generating';
          updates.videoError = null;
        }
        if (Object.keys(updates).length === 0) continue;
        await scopedDb.frames.update(frame.id, updates, {
          throwOnMissing: false,
        });
        await safeEmit(sequenceId, `image-progress:${frame.id}`, () =>
          getGenerationChannel(sequenceId).emit('generation.image:progress', {
            frameId: frame.id,
            status: 'generating',
          })
        );
        if (frame.videoUrl) {
          await safeEmit(sequenceId, `video-progress:${frame.id}`, () =>
            getGenerationChannel(sequenceId).emit('generation.video:progress', {
              frameId: frame.id,
              status: 'generating',
            })
          );
        }
      }
    });
    if (skippedDeletedFrameIds.length > 0) {
      logger.warn(
        `[ReplaceElementWorkflow:cf] Skipping ${skippedDeletedFrameIds.length} deleted frame(s): ${skippedDeletedFrameIds.join(', ')}`
      );
    }

    const editPrompt = buildEditPrompt({
      token,
      newDescription: visionResult.description,
      previousDescription: input.previousDescription,
    });

    // Resolve the image child binding once. Cast to the typed child binding
    // so `spawnAndAwaitChild`'s generic param infers correctly.
    const imageChildBinding = this.env.IMAGE_WORKFLOW;
    if (!imageChildBinding) {
      throw new NonRetryableError(
        '[ReplaceElementWorkflow:cf] IMAGE_WORKFLOW binding missing on env; ' +
          'check wrangler.jsonc and ensure bun cf:typegen has been run'
      );
    }
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the registered binding's runtime payload shape is enforced by the child's typed entrypoint
    const imageBinding = imageChildBinding as Workflow<ImageWorkflowInput>;

    // Parallel fan-out — per-child retries handle backpressure.
    // `allSettled` so a per-frame throw (e.g. timed-out child) doesn't abort
    // sibling frames.
    const imageSpawnPromises = liveFrames.map(
      async (frame, index): Promise<FrameResult> => {
        const sourceImageUrl = frame.thumbnailUrl;
        if (!sourceImageUrl) {
          // Replacement is only meaningful when a primary thumbnail exists;
          // text-to-image regeneration would silently invent a frame from
          // prose alone.
          return {
            frameId: frame.id,
            success: false,
            error: 'no source thumbnail to edit',
          };
        }

        // Prefer the frame's own model when it supports edits, so the swap
        // reads as a continuation of the original render. Fall back to the
        // workflow's edit-capable default otherwise.
        const frameModel = safeTextToImageModel(
          frame.imageModel,
          DEFAULT_IMAGE_MODEL
        );
        const model = supportsReferenceImages(frameModel)
          ? frameModel
          : imageModel;

        const childPayload: ImageWorkflowInput = {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          frameId: frame.id,
          prompt: editPrompt,
          model,
          imageSize: aspectRatioToImageSize(aspectRatio),
          numImages: 1,
          referenceImages: [
            {
              referenceImageUrl: sourceImageUrl,
              description: 'Existing frame to edit',
              role: 'primary',
            },
            {
              referenceImageUrl: newImageUrl,
              description: `${token} - ${visionResult.description}`,
              role: 'element',
            },
          ],
        };

        try {
          const childResult = await spawnAndAwaitChild<
            ImageWorkflowInput,
            ImageChildResult
          >(step, {
            binding: imageBinding,
            parentBindingName: PARENT_BINDING_NAME,
            parentInstanceId: event.instanceId,
            childId: `image:${sequenceId}:${frame.id}`,
            childPayload,
            spawnStepName: `spawn-image-${index}`,
            awaitStepName: `await-image-${index}`,
            timeout: '30 minutes',
          });

          if (!childResult.imageUrl) {
            logger.error(
              `[ReplaceElementWorkflow:cf] Image edit returned empty url frame=${frame.id}`
            );
            return {
              frameId: frame.id,
              success: false,
              error: 'Image edit no imageUrl',
            };
          }

          return {
            frameId: frame.id,
            success: true,
            imageUrl: childResult.imageUrl,
          };
        } catch (e) {
          const reason = rejectionReasonMessage(e);
          logger.error(
            `[ReplaceElementWorkflow:cf] Image edit failed frame=${frame.id} reason=${reason}`
          );
          return {
            frameId: frame.id,
            success: false,
            error: `Image edit failed: ${reason}`,
          };
        }
      }
    );

    const settled = await Promise.allSettled(imageSpawnPromises);

    const results: FrameResult[] = settled.map((s, i) => {
      if (s.status === 'rejected') {
        logger.error('[ReplaceElementWorkflow:cf] Per-frame promise rejected', {
          frameId: liveFrames[i]?.id ?? 'unknown',
          reason: s.reason,
        });
      }
      return settledToResult(s, liveFrames[i]?.id);
    });

    const outcome = decideBatchOutcome(results);
    if (outcome.kind === 'fail') {
      throw new Error(
        `[ReplaceElementWorkflow:cf] All ${outcome.total} frame edit(s) failed for ${token}: ${outcome.sampleReason}`
      );
    }

    // Cascade to videos: for each successfully-edited frame that previously
    // had a video, regenerate the video off the new thumbnail. The frame's
    // `videoStatus` flips to `generating` so the existing UI surfaces the
    // in-flight state on both the image and video pages.
    const successByFrameId = new Map<string, string>();
    for (const r of results) {
      if (r.success) successByFrameId.set(r.frameId, r.imageUrl);
    }
    const videoModel = safeImageToVideoModel(
      sequence.videoModel,
      DEFAULT_VIDEO_MODEL
    );
    const framesNeedingVideoRegen: Frame[] = liveFrames.filter(
      (f) => !!f.videoUrl && successByFrameId.has(f.id)
    );

    let videoSuccessCount = 0;
    let videoFailedCount = 0;
    if (framesNeedingVideoRegen.length > 0) {
      logger.info(
        `[ReplaceElementWorkflow:cf] Regenerating video for ${framesNeedingVideoRegen.length} frame(s) tied to element ${token}`
      );

      const motionChildBinding = this.env.MOTION_WORKFLOW;
      if (!motionChildBinding) {
        throw new NonRetryableError(
          '[ReplaceElementWorkflow:cf] MOTION_WORKFLOW binding missing on env; ' +
            'check wrangler.jsonc and ensure bun cf:typegen has been run'
        );
      }
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the registered binding's runtime payload shape is enforced by the child's typed entrypoint
      const motionBinding = motionChildBinding as Workflow<MotionWorkflowInput>;

      const motionSpawnPromises = framesNeedingVideoRegen.map(
        async (frame, index) => {
          const newThumbnailUrl = successByFrameId.get(frame.id);
          if (!newThumbnailUrl) {
            return { frameId: frame.id, success: false };
          }

          await scopedDb.frames.update(frame.id, {
            videoStatus: 'generating',
            videoError: null,
          });

          const childPayload: MotionWorkflowInput = {
            userId: input.userId,
            teamId: input.teamId,
            sequenceId,
            frameId: frame.id,
            imageUrl: newThumbnailUrl,
            prompt: resolveMotionPrompt(frame, videoModel),
            model: videoModel,
            aspectRatio,
            duration: frame.durationMs ? frame.durationMs / 1000 : undefined,
          };

          try {
            await spawnAndAwaitChild<MotionWorkflowInput, MotionChildResult>(
              step,
              {
                binding: motionBinding,
                parentBindingName: PARENT_BINDING_NAME,
                parentInstanceId: event.instanceId,
                childId: `motion:${sequenceId}:${frame.id}`,
                childPayload,
                spawnStepName: `spawn-motion-${index}`,
                awaitStepName: `await-motion-${index}`,
                timeout: '30 minutes',
              }
            );
            return { frameId: frame.id, success: true };
          } catch (e) {
            logger.error('[ReplaceElementWorkflow:cf] motion child failed:', {
              err: rejectionReasonMessage(e),
            });
            return { frameId: frame.id, success: false };
          }
        }
      );

      const videoSettled = await Promise.allSettled(motionSpawnPromises);
      for (const settledMotion of videoSettled) {
        if (
          settledMotion.status === 'fulfilled' &&
          settledMotion.value.success
        ) {
          videoSuccessCount += 1;
        } else {
          videoFailedCount += 1;
          if (settledMotion.status === 'rejected') {
            logger.error('[ReplaceElementWorkflow:cf] motion regen rejected:', {
              err: rejectionReasonMessage(settledMotion.reason),
            });
          }
        }
      }
    }

    await step.do('emit-complete', () =>
      safeEmit(sequenceId, 'complete', () =>
        getGenerationChannel(sequenceId).emit(
          'generation.replace-element:complete',
          {
            elementId,
            successCount: outcome.successCount,
            failedCount: outcome.failedCount,
            videoSuccessCount,
            videoFailedCount,
            renamedTo,
          }
        )
      )
    );

    logger.info(
      `[ReplaceElementWorkflow:cf] Completed: ${outcome.successCount} edited, ${outcome.failedCount} failed, ${skippedDeletedFrameIds.length} skipped-deleted, videos ${videoSuccessCount}/${videoFailedCount} for element ${token}`
    );

    return {
      elementId,
      successCount: outcome.successCount,
      failedCount: outcome.failedCount,
    };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<ReplaceElementWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;

    // The failure could be in vision (status still `analyzing`) or in a
    // per-frame edit (vision succeeded → status is `completed`). Only
    // downgrade in the first case; otherwise the element card would mislead
    // the user about which step failed.
    //
    // If reading the row throws (Turso blip), default to writing `failed`
    // anyway — better to mislabel as vision-failed than leave the row stuck
    // in `analyzing` forever (the whole point of this recovery).
    let shouldDowngrade = true;
    try {
      const current = await scopedDb.sequenceElements.getById(input.elementId);
      if (current) {
        shouldDowngrade = shouldDowngradeVisionOnFailure(current.visionStatus);
      }
    } catch (e) {
      logger.error(
        '[ReplaceElementWorkflow:cf] Failed to read current element status; assuming vision in-flight:',
        {
          e,
        }
      );
    }

    if (shouldDowngrade) {
      try {
        await scopedDb.sequenceElements.updateVisionStatus(
          input.elementId,
          'failed',
          error
        );
      } catch (e) {
        logger.error(
          '[ReplaceElementWorkflow:cf] Failed to persist vision-failed status:',
          {
            e,
          }
        );
      }
    }

    await safeEmit(input.sequenceId, 'failed', () =>
      getGenerationChannel(input.sequenceId).emit(
        'generation.replace-element:failed',
        { elementId: input.elementId, error }
      )
    );

    logger.error(
      `[ReplaceElementWorkflow:cf] Replace failed for element ${input.token}: ${error}`
    );
  }
}
