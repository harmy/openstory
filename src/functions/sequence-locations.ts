import { mediaUrlSchema } from '@/lib/schemas/media-url.schemas';
import { safeTextToImageModel } from '@/lib/ai/models';
import { type SequenceLocation, StyleConfigSchema } from '@/lib/db/schema';
import { getGenerationChannel } from '@/lib/realtime';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { RecastLocationWorkflowInput } from '@/lib/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware, sequenceAccessMiddleware } from './middleware';

/** Narrow DB text column to the typed union, defaulting to 'interior'. */
function parseLocationType(
  value: string | null
): 'interior' | 'exterior' | 'both' {
  if (value === 'interior' || value === 'exterior' || value === 'both') {
    return value;
  }
  return 'interior';
}

/** Convert flat DB columns to the nested LocationBibleEntry shape. */
function toLocationMetadata(
  location: SequenceLocation
): RecastLocationWorkflowInput['locationMetadata'] {
  return {
    locationId: location.locationId,
    name: location.name,
    type: parseLocationType(location.type),
    timeOfDay: location.timeOfDay ?? '',
    description: location.description ?? '',
    architecturalStyle: location.architecturalStyle ?? '',
    keyFeatures: location.keyFeatures ?? '',
    colorPalette: location.colorPalette ?? '',
    lightingSetup: location.lightingSetup ?? '',
    ambiance: location.ambiance ?? '',
    consistencyTag: location.consistencyTag ?? '',
    firstMention: {
      sceneId: location.firstMentionSceneId ?? '',
      text: location.firstMentionText ?? '',
      lineNumber: location.firstMentionLine ?? 0,
    },
  };
}

export const getSequenceLocationsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceLocations.list(context.sequence.id);
  });

export const getTeamLocationsLibraryFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceLocations.getTeamLibrary(context.teamId, {
      completedOnly: false,
    });
  });

const getShotIdsForLocationInputSchema = z.object({
  locationId: z.string().min(1),
});

export const getShotIdsForLocationFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(getShotIdsForLocationInputSchema))
  .handler(async ({ context, data }) => {
    const shotIds =
      await context.scopedDb.sequenceLocations.getShotIdsForLocation(
        context.sequence.id,
        data.locationId
      );
    return { shotIds, count: shotIds.length };
  });

const recastLocationInputSchema = z.object({
  locationId: z.string().min(1),
  libraryLocationId: z.string().min(1),
  referenceImageUrl: mediaUrlSchema,
  description: z.string().optional(),
});

/**
 * Recast a location with a library location reference.
 * Triggers location reference regeneration and shot regeneration.
 */
export const recastLocationFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(recastLocationInputSchema))
  .handler(async ({ context, data }) => {
    const location = await context.scopedDb.sequenceLocations.getById(
      data.locationId
    );
    if (!location) {
      throw new Error('Location not found');
    }

    // Fetch the sequence's style for location sheet generation
    const sequence = await context.scopedDb.sequences.getForUser({
      sequenceId: location.sequenceId,
    });
    const style = sequence.styleId
      ? await context.scopedDb.styles.getById(sequence.styleId)
      : null;
    const styleConfig = style
      ? StyleConfigSchema.parse(style.config)
      : undefined;

    await context.scopedDb.sequenceLocations.updateReferenceStatus(
      data.locationId,
      'generating'
    );

    await getGenerationChannel(location.sequenceId).emit(
      'generation.location-sheet:progress',
      { locationId: data.locationId, status: 'generating' }
    );

    const affectedShotIds =
      await context.scopedDb.sequenceLocations.getShotIdsForLocation(
        location.sequenceId,
        data.locationId
      );

    const workflowRunId = await triggerWorkflow(
      '/recast-location',
      {
        locationDbId: data.locationId,
        locationName: location.name,
        locationMetadata: toLocationMetadata(location),
        sequenceId: location.sequenceId,
        teamId: context.teamId,
        userId: context.user.id,
        referenceImageUrl: data.referenceImageUrl,
        libraryLocationDescription: data.description,
        imageModel: safeTextToImageModel(sequence.imageModel),
        affectedShotIds,
        styleConfig,
      } satisfies RecastLocationWorkflowInput,
      { label: buildWorkflowLabel(location.sequenceId) }
    );

    return {
      locationId: data.locationId,
      referenceWorkflowRunId: workflowRunId,
      affectedShotIds,
    };
  });
