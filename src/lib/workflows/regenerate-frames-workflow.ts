/**
 * Regenerate Frames Workflow
 *
 * Bulk regenerates frame images after character recast.
 * Includes ALL character sheet references for visual consistency.
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import type { CharacterMinimal } from '@/lib/db/schema';
import { matchLocationsToFrame } from '@/lib/db/scoped/sequence-locations';
import { buildCharacterReferenceImages } from '@/lib/prompts/character-prompt';
import { buildLocationReferenceImages } from '@/lib/prompts/location-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { RegenerateFramesWorkflowInput } from '@/lib/workflow/types';
import { getFalFlowControl } from './constants';
import { generateImageWorkflow } from './image-workflow';

/**
 * Match characters to a frame by their continuity tags.
 * Pure function that works in-memory without DB queries.
 */
function matchCharactersToFrame(
  allCharacters: CharacterMinimal[],
  characterTags: string[]
): CharacterMinimal[] {
  if (characterTags.length === 0) return [];

  return allCharacters.filter((char) => {
    const consistencyTag = (char.consistencyTag ?? '').toLowerCase();
    const charName = char.name.toLowerCase();

    return characterTags.some((tag) => {
      const tagLower = tag.toLowerCase();
      return (
        (consistencyTag && tagLower.includes(consistencyTag)) ||
        (consistencyTag && consistencyTag.includes(tagLower)) ||
        tagLower.includes(charName) ||
        (charName.includes(tagLower) && tagLower.length >= 3) ||
        tagLower.includes(char.characterId.toLowerCase())
      );
    });
  });
}

type FrameResult = {
  frameId: string;
  success: boolean;
  imageUrl?: string;
  error?: string;
};

type RegenerateFramesResult = {
  totalFrames: number;
  successCount: number;
  failedFrames: string[];
};

export const regenerateFramesWorkflow = createScopedWorkflow<
  RegenerateFramesWorkflowInput,
  RegenerateFramesResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const { sequenceId, frameIds, userId, teamId, triggeringCharacterId } =
      input;
    const label = buildWorkflowLabel(sequenceId);

    if (!sequenceId) {
      throw new WorkflowValidationError('Sequence ID is required');
    }

    const sequence = await context.run('get-sequence', async () => {
      const seq = await scopedDb.sequences.getById(sequenceId);
      if (!seq) {
        throw new WorkflowValidationError(`Sequence ${sequenceId} not found`);
      }
      return seq;
    });

    const allCharacters = await context.run('get-all-characters', async () => {
      const chars = await scopedDb.characters.listWithSheets(sequenceId);
      console.log(
        '[RegenerateFramesWorkflow]',
        `Found ${chars.length} characters with completed sheets`
      );
      return chars;
    });

    const allLocations = await context.run('get-all-locations', async () => {
      const locs =
        await scopedDb.sequenceLocations.listWithReferences(sequenceId);
      console.log(
        '[RegenerateFramesWorkflow]',
        `Found ${locs.length} locations with completed reference images`
      );
      return locs;
    });

    const framesToRegenerate = await context.run('get-frames', async () => {
      const frames = await scopedDb.frames.getByIds(frameIds);
      console.log(
        '[RegenerateFramesWorkflow]',
        `Found ${frames.length}/${frameIds.length} frames to regenerate`
      );
      return frames;
    });

    if (framesToRegenerate.length === 0) {
      return { totalFrames: 0, successCount: 0, failedFrames: [] };
    }

    await context.run('emit-start', async () => {
      await getGenerationChannel(sequenceId).emit('generation.recast:start', {
        characterId: triggeringCharacterId,
        frameCount: framesToRegenerate.length,
      });
    });

    const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
    const imageSize = aspectRatioToImageSize(sequence.aspectRatio);

    const imageResults: FrameResult[] = await Promise.all(
      framesToRegenerate.map(async (frame) => {
        if (!frame.imagePrompt) {
          throw new WorkflowValidationError(
            `Frame ${frame.id} has no image prompt`
          );
        }

        const characterTags = frame.metadata?.continuity?.characterTags ?? [];
        const frameCharacters = matchCharactersToFrame(
          allCharacters,
          characterTags
        );
        const frameLocations = matchLocationsToFrame(frame, allLocations);

        const referenceImages = [
          ...buildCharacterReferenceImages(frameCharacters),
          ...buildLocationReferenceImages(frameLocations),
        ];

        const { body, isFailed, isCanceled } = await context.invoke('image', {
          workflow: generateImageWorkflow,
          label,
          body: {
            userId,
            teamId,
            sequenceId,
            frameId: frame.id,
            prompt: frame.imagePrompt,
            model: imageModel,
            imageSize,
            numImages: 1,
            referenceImages,
          },
          retries: 3,
          retryDelay: 'pow(2, retried) * 1000',
          flowControl: getFalFlowControl(),
        });

        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        if (isFailed || isCanceled || !body?.imageUrl) {
          return {
            frameId: frame.id,
            success: false,
            error: 'Image generation failed',
          };
        }

        return {
          frameId: frame.id,
          success: true,
          imageUrl: body.imageUrl,
        };
      })
    );

    const failedFrames = imageResults
      .filter((r) => !r.success)
      .map((r) => r.frameId);
    const successCount = imageResults.length - failedFrames.length;

    await context.run('emit-complete', async () => {
      await getGenerationChannel(sequenceId).emit(
        'generation.recast:complete',
        {
          characterId: triggeringCharacterId,
          successCount,
          failedCount: failedFrames.length,
        }
      );
    });

    console.log(
      '[RegenerateFramesWorkflow]',
      `Completed: ${successCount} success, ${failedFrames.length} failed`
    );

    return {
      totalFrames: framesToRegenerate.length,
      successCount,
      failedFrames,
    };
  },
  {
    failureFunction: async ({ context, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);

      await getGenerationChannel(input.sequenceId).emit(
        'generation.recast:failed',
        {
          characterId: input.triggeringCharacterId,
          error,
        }
      );

      console.error(
        '[RegenerateFramesWorkflow]',
        `Frame regeneration failed: ${error}`
      );

      return `Frame regeneration failed: ${error}`;
    },
  }
);
