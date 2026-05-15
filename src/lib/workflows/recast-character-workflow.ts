/**
 * Recast Character Workflow
 *
 * Orchestrates the full recast flow:
 * 1. Generate new character sheet with talent appearance
 * 2. Regenerate all frames containing the character
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { getGenerationChannel } from '@/lib/realtime';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { RecastCharacterWorkflowInput } from '@/lib/workflow/types';
import { characterSheetWorkflow } from './character-sheet-workflow';
import {
  buildRegenerateFrameSnapshot,
  computeRegenerateFramesBatchHash,
} from './regenerate-frames-snapshot';
import { regenerateFramesWorkflow } from './regenerate-frames-workflow';
import {
  computeCharacterSheetHashFromDto,
  resolveTalentSheetHash,
} from './sheet-snapshots';
import type { CharacterSheetWorkflowInput } from '@/lib/workflow/types';

export const recastCharacterWorkflow =
  createScopedWorkflow<RecastCharacterWorkflowInput>(
    async (context, scopedDb) => {
      const input = context.requestPayload;
      const label = buildWorkflowLabel(input.sequenceId);

      // Step 1: Generate character sheet showing talent in costume.
      // Resolve the upstream talent-sheet hash and inline it so the child
      // workflow can detect divergence if the talent sheet is regenerated
      // mid-flight.
      const sheetBody = await context.run(
        'build-character-sheet-snapshot',
        async (): Promise<CharacterSheetWorkflowInput> => {
          console.log(
            '[RecastCharacterWorkflow]',
            `Starting recast for ${input.characterName} with ${input.affectedFrameIds.length} affected frames`
          );
          const talentSheetInputHash = await resolveTalentSheetHash(
            scopedDb,
            input.characterDbId
          );
          const partial: CharacterSheetWorkflowInput = {
            characterDbId: input.characterDbId,
            characterName: input.characterName,
            characterMetadata: input.characterMetadata,
            sequenceId: input.sequenceId,
            teamId: input.teamId,
            userId: input.userId,
            imageModel: input.imageModel,
            referenceImageUrl: input.referenceImageUrl,
            talentMetadata: input.talentMetadata,
            talentDescription: input.talentDescription,
            styleConfig: input.styleConfig,
            talentSheetInputHash,
          };
          partial.snapshotInputHash =
            await computeCharacterSheetHashFromDto(partial);
          return partial;
        }
      );

      const { body: sheetResult, isFailed: sheetFailed } = await context.invoke(
        'character-sheet',
        {
          workflow: characterSheetWorkflow,
          label,
          body: sheetBody,
        }
      );

      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (sheetFailed || !sheetResult?.sheetImageUrl) {
        throw new Error(
          `Character sheet generation failed for ${input.characterName}`
        );
      }

      const sheetImageUrl = sheetResult.sheetImageUrl;

      // Step 2: Regenerate frames if there are any affected
      let framesRegenerated = 0;
      let framesFailed = 0;

      if (input.affectedFrameIds.length > 0) {
        const sequenceId = input.sequenceId;
        if (!sequenceId) {
          throw new Error(
            '[RecastCharacterWorkflow] sequenceId is required to regenerate frames'
          );
        }
        const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
        const regenerateBody = await context.run(
          'build-regenerate-snapshot',
          async () => {
            const sequence = await scopedDb.sequences.getById(sequenceId);
            if (!sequence) {
              throw new Error(
                `[RecastCharacterWorkflow] Sequence ${sequenceId} not found`
              );
            }
            const [characters, locations, frames] = await Promise.all([
              scopedDb.characters.listWithSheets(sequenceId),
              scopedDb.sequenceLocations.listWithReferences(sequenceId),
              scopedDb.frames.getByIds(input.affectedFrameIds),
            ]);
            // Reject silent drops: getByIds returns only existing rows, so a
            // missing frame would shrink frameSnapshots below frameIds without
            // any signal. Surface the gap so the caller can fix data drift
            // instead of zero-counting frames that never ran.
            if (frames.length !== input.affectedFrameIds.length) {
              const found = new Set(frames.map((f) => f.id));
              const missing = input.affectedFrameIds.filter(
                (id) => !found.has(id)
              );
              throw new Error(
                `[RecastCharacterWorkflow] Missing frames for ${input.characterName}: ${missing.join(', ')}`
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
            const partial = {
              sequenceId,
              imageModel,
              aspectRatio,
              frameSnapshots,
            };
            const snapshotInputHash =
              await computeRegenerateFramesBatchHash(partial);
            return {
              userId: input.userId,
              teamId: input.teamId,
              sequenceId,
              frameIds: input.affectedFrameIds,
              triggerKind: 'character' as const,
              triggerId: input.characterDbId,
              imageModel,
              aspectRatio,
              frameSnapshots,
              snapshotInputHash,
            };
          }
        );

        const { body: regenerateResult, isFailed: regenerateFailed } =
          await context.invoke('regenerate-frames', {
            workflow: regenerateFramesWorkflow,
            label,
            body: regenerateBody,
          });

        if (regenerateFailed) {
          // The child workflow's failureFunction has already emitted
          // recast:failed. Throw so the parent's failureFunction also fires
          // and the caller sees a real failure rather than zeroed counts.
          throw new Error(
            `[RecastCharacterWorkflow] Frame regeneration failed for ${input.characterName}; sheet was generated but no frames were updated`
          );
        }
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        framesRegenerated = regenerateResult?.successCount ?? 0;
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        framesFailed = regenerateResult?.failedFrames?.length ?? 0;
      }

      return {
        sheetImageUrl,
        framesRegenerated,
        framesFailed,
      };
    },
    {
      failureFunction: async ({ context, failResponse }) => {
        const input = context.requestPayload;
        const error = sanitizeFailResponse(failResponse);

        await getGenerationChannel(input.sequenceId).emit(
          'generation.recast:failed',
          {
            characterId: input.characterDbId,
            error,
          }
        );

        console.error(
          '[RecastCharacterWorkflow]',
          `Recast failed for ${input.characterName}: ${error}`
        );

        return `Recast failed for ${input.characterName}`;
      },
    }
  );
