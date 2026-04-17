/**
 * Character Sheet Generation Workflow
 *
 * Generates character reference sheets (full body turnaround) for visual consistency.
 * These sheets are later used as reference images when generating scene images.
 *
 * When talent matches are provided, uses the talent's appearance and reference image
 * to maintain consistency with the cast.
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import {
  deductWorkflowCredits,
  extractImageCost,
} from '@/lib/billing/workflow-deduction';
import { generateId } from '@/lib/db/id';
import type { CharacterMinimal, NewCharacter } from '@/lib/db/schema';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import {
  buildCastingAttributes,
  buildCharacterSheetPrompt,
} from '@/lib/prompts/character-prompt';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  CharacterBibleWorkflowInput,
  TalentCharacterMatch,
} from '@/lib/workflow/types';

export const characterBibleWorkflow = createScopedWorkflow<
  CharacterBibleWorkflowInput,
  CharacterMinimal[]
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const { talentMatches = [] } = input;

    // Create lookup map for talent matches
    const matchMap = new Map<string, TalentCharacterMatch>(
      talentMatches.map((m) => [m.characterId, m])
    );

    // Step 1: Insert character records into database (always runs - satisfies Upstash auth check)
    const createdCharacters = await context.run(
      'create-character-records',
      async () => {
        if (!input.sequenceId || !input.userId || !input.teamId) {
          return [];
        }

        const results: Array<{ id: string; characterId: string }> = [];
        for (const character of input.characterBible) {
          const talentMatch = matchMap.get(character.characterId);
          const castingAttrs = talentMatch
            ? buildCastingAttributes(character, {
                sheetMetadata: talentMatch.sheetMetadata,
                talentName: talentMatch.talentName,
              })
            : null;

          const created = await scopedDb.characters.create({
            id: generateId(),
            sequenceId: input.sequenceId,
            characterId: character.characterId,
            name: character.name,
            age: castingAttrs?.age ?? character.age,
            gender: castingAttrs?.gender ?? character.gender,
            ethnicity: castingAttrs?.ethnicity ?? character.ethnicity,
            physicalDescription:
              castingAttrs?.physicalDescription ??
              character.physicalDescription,
            standardClothing: character.standardClothing,
            distinguishingFeatures: character.distinguishingFeatures,
            consistencyTag:
              castingAttrs?.consistencyTag ?? character.consistencyTag,
            firstMentionSceneId: null,
            firstMentionText: null,
            firstMentionLine: null,
            sheetImageUrl: null,
            sheetImagePath: null,
            sheetStatus: 'generating' as const,
            talentId: talentMatch?.talentId ?? null,
          } satisfies NewCharacter);
          results.push({ id: created.id, characterId: created.characterId });
        }
        return results;
      }
    );

    if (input.characterBible.length === 0) {
      return [];
    }

    // Create mapping from characterId to database id
    const characterIdToDbId = new Map<string, string>(
      createdCharacters.map((c) => [c.characterId, c.id])
    );

    // Step 2: Generate character sheet images in parallel
    const seqCharacters: CharacterMinimal[] = await Promise.all(
      input.characterBible.map(async (character, index) => {
        const dbId = characterIdToDbId.get(character.characterId);

        return await context.run(`character-sheet-${index}`, async () => {
          const talentMatch = matchMap.get(character.characterId);
          const castingAttrs = talentMatch
            ? buildCastingAttributes(character, {
                sheetMetadata: talentMatch.sheetMetadata,
                talentName: talentMatch.talentName,
              })
            : null;

          // Generate character sheet (with talent appearance as reference + sequence style)
          const { prompt, referenceUrls } = talentMatch
            ? buildCharacterSheetPrompt(
                character,
                {
                  sheetMetadata: talentMatch.sheetMetadata,
                  description: `This character must look exactly like ${talentMatch.talentName}`,
                  sheetImageUrl: talentMatch.sheetImageUrl,
                },
                input.styleConfig
              )
            : buildCharacterSheetPrompt(
                character,
                undefined,
                input.styleConfig
              );

          const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

          const imageResult = await generateImageWithProvider(
            {
              model,
              prompt,
              imageSize: 'landscape_16_9' as const,
              numImages: 1,
              resolution: '2K' as const,
              referenceImageUrls:
                referenceUrls.length > 0 ? referenceUrls : undefined,
              traceName: 'character-bible-image',
            },
            { scopedDb }
          );

          await deductWorkflowCredits({
            scopedDb,
            costMicros: extractImageCost(imageResult.metadata),
            usedOwnKey: imageResult.metadata.usedOwnKey,
            description: `Character bible sheet (${model})`,
            metadata: { model, characterId: character.characterId },
            workflowName: 'CharacterBibleWorkflow',
          });

          const generatedUrl = imageResult.imageUrls[0];
          if (!generatedUrl) {
            throw new Error('No image URL returned from generation');
          }

          let sheetImageUrl: string;
          let sheetImagePath: string | undefined;

          // Upload to R2 if we have storage context
          if (input.sequenceId && input.teamId) {
            const storagePath = `${input.teamId}/${input.sequenceId}/${dbId ?? generateId()}.png`;
            const response = await fetch(generatedUrl);
            if (!response.ok) {
              throw new Error(
                `Failed to fetch generated image: ${response.status}`
              );
            }
            const storageResult = await uploadResponse(
              response,
              STORAGE_BUCKETS.CHARACTERS,
              storagePath,
              { contentType: 'image/png' }
            );
            sheetImageUrl = storageResult.publicUrl;
            sheetImagePath = storageResult.path;
          } else {
            sheetImageUrl = generatedUrl;
            sheetImagePath = undefined;
          }

          // Update existing DB record with sheet image
          if (dbId) {
            await scopedDb.characters.updateSheet(
              dbId,
              sheetImageUrl,
              sheetImagePath ?? ''
            );
            return {
              id: dbId,
              characterId: character.characterId,
              name: character.name,
              sheetImageUrl,
              sheetStatus: 'completed' as const,
              physicalDescription:
                castingAttrs?.physicalDescription ??
                character.physicalDescription,
              consistencyTag:
                castingAttrs?.consistencyTag ?? character.consistencyTag,
            };
          }

          return {
            id: generateId(),
            characterId: character.characterId,
            name: character.name,
            sheetImageUrl,
            sheetStatus: 'completed' as const,
            physicalDescription:
              castingAttrs?.physicalDescription ??
              character.physicalDescription,
            consistencyTag:
              castingAttrs?.consistencyTag ?? character.consistencyTag,
          };
        });
      })
    );

    return seqCharacters;
  },
  {
    failureFunction: async ({ failResponse }) => {
      const error = sanitizeFailResponse(failResponse);
      console.error(
        '[CharacterBibleWorkflow]',
        `Character sheet generation failed: ${error}`
      );
      return `Character sheet generation failed`;
    },
  }
);
