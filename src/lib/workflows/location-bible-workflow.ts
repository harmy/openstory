/**
 * Location Bible Workflow
 *
 * Generates location reference images for all locations in a sequence.
 * Creates establishing shots that are used for visual consistency across scenes.
 *
 * This workflow:
 * 1. Inserts location records into the database from the location bible
 * 2. Generates reference images for each location
 * 3. Updates database with reference image URLs
 */

import { uploadResponse } from '@/lib/storage/upload-response';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import {
  deductWorkflowCredits,
  extractImageCost,
} from '@/lib/billing/workflow-deduction';
import { generateId } from '@/lib/db/id';
import type {
  NewSequenceLocation,
  SequenceLocationMinimal,
} from '@/lib/db/schema';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { buildLocationSheetPrompt } from '@/lib/prompts/location-prompt';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  LibraryLocationMatch,
  LocationBibleWorkflowInput,
} from '@/lib/workflow/types';

export const locationBibleWorkflow = createScopedWorkflow<
  LocationBibleWorkflowInput,
  SequenceLocationMinimal[]
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const { libraryLocationMatches = [] } = input;

    // Create lookup map for library location matches
    const matchMap = new Map<string, LibraryLocationMatch>(
      libraryLocationMatches.map((m) => [m.locationId, m])
    );

    // Step 1: Insert locations into database
    const createdLocations = await context.run(
      'create-location-records',
      async () => {
        const sequenceId = input.sequenceId;
        if (!sequenceId) {
          return [];
        }

        const locationInserts: NewSequenceLocation[] = input.locationBible.map(
          (location) => {
            // Check if there's a library match for this location
            const libraryMatch = matchMap.get(location.locationId);

            return {
              id: generateId(),
              sequenceId,
              locationId: location.locationId,
              name: location.name,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              type: location.type ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              timeOfDay: location.timeOfDay ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              description: location.description ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              architecturalStyle: location.architecturalStyle ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              keyFeatures: location.keyFeatures ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              colorPalette: location.colorPalette ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              lightingSetup: location.lightingSetup ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              ambiance: location.ambiance ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              consistencyTag: location.consistencyTag ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              firstMentionSceneId: location.firstMention?.sceneId ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              firstMentionText: location.firstMention?.text ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              firstMentionLine: location.firstMention?.lineNumber ?? null,
              referenceStatus: 'generating' as const,
              // Link to library location if matched
              libraryLocationId: libraryMatch?.libraryLocationId ?? null,
            };
          }
        );

        return await scopedDb.sequenceLocations.createBulk(locationInserts);
      }
    );

    // Create a mapping from locationId (from bible) to database id
    const locationIdToDbId = new Map<string, string>(
      createdLocations.map((loc) => [loc.locationId, loc.id])
    );

    // Step 2: Generate reference images for each location in parallel
    const seqLocations: SequenceLocationMinimal[] = await Promise.all(
      input.locationBible.map(async (location, index) => {
        const dbId = locationIdToDbId.get(location.locationId);

        return await context.run(`location-sheet-${index}`, async () => {
          // Check if location has a library match
          const libraryMatch = matchMap.get(location.locationId);

          // Build location sheet prompt (with library overrides if matched + sequence style)
          const { prompt, referenceUrls } = libraryMatch
            ? buildLocationSheetPrompt(
                location,
                {
                  description: libraryMatch.description,
                  referenceImageUrl: libraryMatch.referenceImageUrl,
                },
                input.styleConfig
              )
            : buildLocationSheetPrompt(location, undefined, input.styleConfig);

          const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

          // Generate location reference image
          const imageResult = await generateImageWithProvider(
            {
              model,
              prompt,
              imageSize: 'landscape_16_9' as const,
              numImages: 1,
              referenceImageUrls:
                referenceUrls.length > 0 ? referenceUrls : undefined,
              traceName: 'location-bible-image',
            },
            { scopedDb }
          );

          // Deduct credits (skip if team used own fal key)
          await deductWorkflowCredits({
            scopedDb,
            costMicros: extractImageCost(imageResult.metadata),
            usedOwnKey: imageResult.metadata.usedOwnKey,
            description: `Location bible sheet (${model})`,
            metadata: { model, locationId: location.locationId },
            workflowName: 'LocationBibleWorkflow',
          });

          const imageUrl = imageResult.imageUrls[0];
          if (!imageUrl) {
            throw new Error('No image URL returned from generation');
          }

          // Save to R2 and update DB if we have all required IDs
          if (dbId && input.sequenceId && input.teamId) {
            const uniqueId = generateId();
            const storagePath = `${input.teamId}/${input.sequenceId}/${dbId}/${uniqueId}.png`;

            // Fetch and stream directly to R2
            const response = await fetch(imageUrl);
            if (!response.ok) {
              throw new Error(
                `Failed to fetch generated image: ${response.status}`
              );
            }

            const storageResult = await uploadResponse(
              response,
              STORAGE_BUCKETS.LOCATIONS,
              storagePath,
              { contentType: 'image/png' }
            );

            // Update location record with reference image
            await scopedDb.sequenceLocations.updateReference(
              dbId,
              storageResult.publicUrl,
              storageResult.path
            );

            return {
              id: dbId,
              locationId: location.locationId,
              name: location.name,
              referenceImageUrl: storageResult.publicUrl,
              referenceStatus: 'completed' as const,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              description: location.description ?? null,
              // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
              consistencyTag: location.consistencyTag ?? null,
            };
          }

          return {
            id: dbId ?? generateId(),
            locationId: location.locationId,
            name: location.name,
            referenceImageUrl: imageUrl,
            referenceStatus: 'completed' as const,
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
            description: location.description ?? null,
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
            consistencyTag: location.consistencyTag ?? null,
          };
        });
      })
    );

    return seqLocations;
  },
  {
    failureFunction: async ({ failResponse }) => {
      const error = sanitizeFailResponse(failResponse);

      console.error(
        '[LocationBibleWorkflow]',
        `Location reference generation failed: ${error}`
      );

      return `Location bible generation failed`;
    },
  }
);
