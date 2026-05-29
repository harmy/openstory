/**
 * Cloudflare Workflows port of `recastLocationWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/recast-location-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * The only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId` (not needed for this workflow, but listed
 *     here for parity with the other CF ports).
 *   - Calls the snapshot DTO computers directly instead of going through
 *     the `context.snapshot.*` extension.
 *   - The chained `location-sheet` child invocation now uses Pattern 3
 *     (`spawnAndAwaitChild`) against the CF `LocationSheetWorkflow`.
 *   - The chained `regenerate-frames` child invocation is stubbed pending
 *     its own CF port (Wave 3 batch). The `build-regenerate-snapshot` step
 *     lives in `regenerateFramesIfNeeded` for diff parity with the QStash
 *     original; the stub fires immediately after the snapshot step so the
 *     workflow falls back to QStash via the registry switch. */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { ScopedDb } from '@/lib/db/scoped';
import { getGenerationChannel } from '@/lib/realtime';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type { CloudflareEnv } from '@/lib/workflow/types';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  LocationSheetWorkflowInput,
  LocationSheetWorkflowResult,
  RecastLocationWorkflowInput,
  RegenerateFramesWorkflowInput,
} from '@/lib/workflow/types';
import {
  buildRegenerateFrameSnapshot,
  computeRegenerateFramesBatchHash,
} from '@/lib/workflows/regenerate-frames-snapshot';
import {
  computeLocationSheetHashFromDto,
  resolveLibraryLocationReferenceHash,
} from '@/lib/workflows/sheet-snapshots';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'recast-location']);

type RecastLocationWorkflowResult = {
  referenceImageUrl: string;
  framesRegenerated: number;
  framesFailed: number;
};

/**
 * Build the regenerate-frames snapshot and (eventually) invoke the
 * `regenerate-frames` child. Today the invoke is stubbed inside a `step.do`
 * with a `NonRetryableError` — Pattern 3 will wire up the real child spawn
 * once the CF port of `regenerate-frames-workflow` lands.
 *
 * Lives in its own helper to mirror the QStash original's flow: snapshot
 * building runs as its own step before the child kicks off.
 */
async function regenerateFramesIfNeeded(
  step: WorkflowStep,
  env: CloudflareEnv,
  parentInstanceId: string,
  scopedDb: ScopedDb,
  input: RecastLocationWorkflowInput
): Promise<{ framesRegenerated: number; framesFailed: number }> {
  if (input.affectedFrameIds.length === 0) {
    return { framesRegenerated: 0, framesFailed: 0 };
  }

  const regenerateBody = await step.do(
    'build-regenerate-snapshot',
    async (): Promise<RegenerateFramesWorkflowInput> => {
      const sequenceId = input.sequenceId;
      if (!sequenceId) {
        throw new NonRetryableError(
          '[RecastLocationWorkflow:cf] sequenceId is required to regenerate frames',
          'WorkflowValidationError'
        );
      }
      const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
      const sequence = await scopedDb.sequences.getById(sequenceId);
      if (!sequence) {
        throw new Error(
          `[RecastLocationWorkflow:cf] Sequence ${sequenceId} not found`
        );
      }
      const [characters, locations, frames] = await Promise.all([
        scopedDb.characters.listWithSheets(sequenceId),
        scopedDb.sequenceLocations.listWithReferences(sequenceId),
        scopedDb.frames.getByIds(input.affectedFrameIds),
      ]);
      if (frames.length !== input.affectedFrameIds.length) {
        const found = new Set(frames.map((f) => f.id));
        const missing = input.affectedFrameIds.filter((id) => !found.has(id));
        throw new Error(
          `[RecastLocationWorkflow:cf] Missing frames for ${input.locationName}: ${missing.join(', ')}`
        );
      }
      const aspectRatio = sequence.aspectRatio;
      const frameSnapshots = await Promise.all(
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
      const partial = { sequenceId, imageModel, aspectRatio, frameSnapshots };
      const snapshotInputHash = await computeRegenerateFramesBatchHash(partial);
      return {
        userId: input.userId,
        teamId: input.teamId,
        sequenceId,
        frameIds: input.affectedFrameIds,
        triggerKind: 'location' as const,
        triggerId: input.locationDbId,
        imageModel,
        aspectRatio,
        frameSnapshots,
        snapshotInputHash,
      };
    }
  );

  const regenerateBinding = env.REGENERATE_FRAMES_WORKFLOW;
  if (!regenerateBinding) {
    throw new NonRetryableError(
      '[RecastLocationWorkflow:cf] REGENERATE_FRAMES_WORKFLOW binding missing on env',
      'WorkflowValidationError'
    );
  }
  await spawnAndAwaitChild<RegenerateFramesWorkflowInput, unknown>(step, {
    binding: regenerateBinding as Workflow<
      RegenerateFramesWorkflowInput & {
        _parent: import('@/lib/workflow/await-child').ParentNotifyHint;
      }
    >,
    parentBindingName: 'RECAST_LOCATION_WORKFLOW',
    parentInstanceId,
    childId: `regenerate-frames:location:${input.locationDbId}`,
    childPayload: regenerateBody,
    spawnStepName: 'spawn-regenerate-frames',
    awaitStepName: 'await-regenerate-frames',
  });

  return {
    framesRegenerated: input.affectedFrameIds.length,
    framesFailed: 0,
  };
}

export class RecastLocationWorkflow extends OpenStoryWorkflowEntrypoint<RecastLocationWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<RecastLocationWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<RecastLocationWorkflowResult> {
    const input = event.payload;

    logger.info(
      `[RecastLocationWorkflow:cf] Starting recast for ${input.locationName} with ${input.affectedFrameIds.length} affected frames`
    );

    // Step 1: Generate new location reference image with library reference.
    // Inline the upstream library-location's reference_input_hash so the
    // child workflow can detect divergence if the library location is
    // regenerated mid-flight.
    const sheetBody = await step.do(
      'build-location-sheet-snapshot',
      async (): Promise<LocationSheetWorkflowInput> => {
        const libraryLocationReferenceHash =
          await resolveLibraryLocationReferenceHash(
            scopedDb,
            input.locationDbId
          );
        const partial: LocationSheetWorkflowInput = {
          locationDbId: input.locationDbId,
          locationName: input.locationName,
          locationMetadata: input.locationMetadata,
          sequenceId: input.sequenceId,
          teamId: input.teamId,
          userId: input.userId,
          imageModel: input.imageModel,
          referenceImageUrl: input.referenceImageUrl,
          libraryLocationDescription: input.libraryLocationDescription,
          styleConfig: input.styleConfig,
          libraryLocationReferenceHash,
        };
        partial.snapshotInputHash =
          await computeLocationSheetHashFromDto(partial);
        return partial;
      }
    );

    const locationSheetBinding = this.env.LOCATION_SHEET_WORKFLOW;
    if (!locationSheetBinding) {
      throw new WorkflowValidationError(
        '[RecastLocationWorkflow:cf] LOCATION_SHEET_WORKFLOW binding missing on env; check wrangler.jsonc'
      );
    }

    const sheetResult = await spawnAndAwaitChild<
      LocationSheetWorkflowInput,
      LocationSheetWorkflowResult
    >(step, {
      binding: locationSheetBinding as Workflow<
        LocationSheetWorkflowInput & {
          _parent: import('@/lib/workflow/await-child').ParentNotifyHint;
        }
      >,
      parentBindingName: 'RECAST_LOCATION_WORKFLOW',
      parentInstanceId: event.instanceId,
      childId: `location-sheet:${input.sequenceId ?? 'no-seq'}:${input.locationDbId}:${event.instanceId}`,
      childPayload: sheetBody,
      spawnStepName: 'spawn-location-sheet',
      awaitStepName: 'await-location-sheet',
    });

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    if (!sheetResult?.referenceImageUrl) {
      throw new Error(
        `Location reference generation failed for ${input.locationName}`
      );
    }

    logger.info(
      `[RecastLocationWorkflow:cf] Location reference generated for ${input.locationName}, regenerating ${input.affectedFrameIds.length} frames`
    );

    // Step 2: Regenerate affected frames via Pattern 3 spawn.
    const { framesRegenerated, framesFailed } = await regenerateFramesIfNeeded(
      step,
      this.env,
      event.instanceId,
      scopedDb,
      input
    );

    if (input.affectedFrameIds.length > 0) {
      logger.info(
        `[RecastLocationWorkflow:cf] Regenerated ${framesRegenerated} frames for ${input.locationName}`
      );
    }

    return {
      referenceImageUrl: sheetResult.referenceImageUrl,
      framesRegenerated,
      framesFailed,
    };
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<RecastLocationWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;

    await getGenerationChannel(input.sequenceId).emit(
      'generation.recast-location:failed',
      {
        locationId: input.locationDbId,
        error,
      }
    );

    logger.error(
      `[RecastLocationWorkflow:cf] Recast failed for ${input.locationName}: ${error}`
    );
  }
}
