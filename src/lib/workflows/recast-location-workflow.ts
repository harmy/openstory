/**
 * Recast Location Workflow
 *
 * Orchestrates the full location recast flow:
 * 1. Generate new location reference image with library reference
 * 2. Regenerate all frames at this location
 */

import { getGenerationChannel } from '@/lib/realtime';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { RecastLocationWorkflowInput } from '@/lib/workflow/types';
import { locationSheetWorkflow } from './location-sheet-workflow';
import { regenerateFramesWorkflow } from './regenerate-frames-workflow';

export const recastLocationWorkflow =
  createScopedWorkflow<RecastLocationWorkflowInput>(
    async (context, _scopedDb) => {
      const input = context.requestPayload;
      const label = buildWorkflowLabel(input.sequenceId);

      console.log(
        '[RecastLocationWorkflow]',
        `Starting recast for ${input.locationName} with ${input.affectedFrameIds.length} affected frames`
      );

      // Step 1: Generate new location reference image with library reference
      const { body: sheetResult, isFailed: sheetFailed } = await context.invoke(
        'location-sheet',
        {
          workflow: locationSheetWorkflow,
          label,
          body: {
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
          },
        }
      );

      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (sheetFailed || !sheetResult?.referenceImageUrl) {
        throw new Error(
          `Location reference generation failed for ${input.locationName}`
        );
      }

      console.log(
        '[RecastLocationWorkflow]',
        `Location reference generated for ${input.locationName}, regenerating ${input.affectedFrameIds.length} frames`
      );

      // Step 2: Regenerate frames if there are any affected
      let framesRegenerated = 0;
      let framesFailed = 0;

      if (input.affectedFrameIds.length > 0) {
        const { body: regenerateResult, isFailed: regenerateFailed } =
          await context.invoke('regenerate-frames', {
            workflow: regenerateFramesWorkflow,
            label,
            body: {
              sequenceId: input.sequenceId,
              userId: input.userId,
              teamId: input.teamId,
              frameIds: input.affectedFrameIds,
              triggeringCharacterId: input.locationDbId,
              imageModel: input.imageModel,
            },
          });

        if (regenerateFailed) {
          console.error(
            '[RecastLocationWorkflow]',
            `Frame regeneration failed for ${input.locationName}`
          );
        } else {
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
          framesRegenerated = regenerateResult?.successCount ?? 0;
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
          framesFailed = regenerateResult?.failedFrames?.length ?? 0;
          console.log(
            '[RecastLocationWorkflow]',
            `Regenerated ${framesRegenerated} frames for ${input.locationName}`
          );
        }
      }

      return {
        referenceImageUrl: sheetResult.referenceImageUrl,
        framesRegenerated,
        framesFailed,
      };
    },
    {
      failureFunction: async ({ context, failResponse }) => {
        const input = context.requestPayload;
        const error = sanitizeFailResponse(failResponse);

        await getGenerationChannel(input.sequenceId).emit(
          'generation.recast-location:failed',
          {
            locationId: input.locationDbId,
            error,
          }
        );

        console.error(
          '[RecastLocationWorkflow]',
          `Recast failed for ${input.locationName}: ${error}`
        );

        return `Recast failed for ${input.locationName}`;
      },
    }
  );
