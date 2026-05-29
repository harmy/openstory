/**
 * Cloudflare Workflows port of `characterBibleWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/character-bible-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - The QStash original inlined the per-character sheet generation; this
 *     port fans out to the `CharacterSheetWorkflow` child via Pattern 3
 *     (`spawnAndAwaitChild`) so the parent stays thin and the children get
 *     their own retry budget. See await-child.ts.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`. */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { generateId } from '@/lib/db/id';
import type { ScopedDb } from '@/lib/db/scoped';
import type { CharacterMinimal, NewCharacter } from '@/lib/db/schema';
import { buildCastingAttributes } from '@/lib/prompts/character-prompt';
import { spawnAndAwaitChild } from '@/lib/workflow/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  CharacterBibleWorkflowInput,
  CharacterSheetWorkflowInput,
  CharacterSheetWorkflowResult,
  TalentCharacterMatch,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'character-bible']);

// NOTE: `CHARACTER_BIBLE_WORKFLOW` is not yet declared on `CloudflareEnv` —
// the parent binding gets wired into `src/lib/workflow/types.ts` and
// `wrangler.jsonc` as part of the follow-on infra PR. Until then, the
// `parentBindingName` below is a string cast; the runtime lookup in
// `notifyParent` / `notifyParentOfFailure` would only fire if this workflow
// itself were spawned as a child (it's a top-level orchestrator today, so
// `_parent` is always undefined and the cast is dormant).
// TODO(#728-wire-up): drop the cast once types.ts knows about
// CHARACTER_BIBLE_WORKFLOW.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- binding name not yet declared on CloudflareEnv; see TODO above
const PARENT_BINDING_NAME = 'CHARACTER_BIBLE_WORKFLOW' as unknown as Parameters<
  typeof spawnAndAwaitChild
>[1]['parentBindingName'];

export class CharacterBibleWorkflow extends OpenStoryWorkflowEntrypoint<CharacterBibleWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<CharacterBibleWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<CharacterMinimal[]> {
    const input = event.payload;
    const { talentMatches = [] } = input;

    // Create lookup map for talent matches
    const matchMap = new Map<string, TalentCharacterMatch>(
      talentMatches.map((m) => [m.characterId, m])
    );

    // Step 1: Insert character records into database (always runs - mirrors
    // the QStash original which used this to satisfy the Upstash auth check).
    const createdCharacters = await step.do(
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

    // Resolve the child binding once. Cast to the typed child binding so
    // `spawnAndAwaitChild`'s generic param infers correctly. The base-class
    // payload validation guarantees the binding is present at runtime when
    // the workflow is canaried.
    const childBinding = this.env.CHARACTER_SHEET_WORKFLOW;
    if (!childBinding) {
      throw new NonRetryableError(
        '[CharacterBibleWorkflow:cf] CHARACTER_SHEET_WORKFLOW binding missing on env; ' +
          'check wrangler.jsonc and ensure bun cf:typegen has been run'
      );
    }
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- the registered binding's runtime payload shape is enforced by the child's typed entrypoint
    const characterSheetBinding =
      childBinding as Workflow<CharacterSheetWorkflowInput>;

    const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;

    // Step 2: Fan out one CharacterSheetWorkflow child per character. Spawns
    // happen in parallel via Promise.all; the awaits use Promise.allSettled
    // so a single timed-out child does not tank the entire parent run.
    const spawnPromises = input.characterBible.map(async (character, index) => {
      const characterDbId = characterIdToDbId.get(character.characterId);
      if (!characterDbId) {
        throw new WorkflowValidationError(
          `[CharacterBibleWorkflow:cf] No DB id found for character ${character.characterId}; ` +
            `create-character-records did not return a matching row`
        );
      }

      const talentMatch = matchMap.get(character.characterId);
      const castingAttrs = talentMatch
        ? buildCastingAttributes(character, {
            sheetMetadata: talentMatch.sheetMetadata,
            talentName: talentMatch.talentName,
          })
        : null;

      const childPayload: CharacterSheetWorkflowInput = {
        userId: input.userId,
        teamId: input.teamId,
        sequenceId: input.sequenceId,
        characterDbId,
        characterName: character.name,
        characterMetadata: character,
        imageModel,
        referenceImageUrl: talentMatch?.sheetImageUrl,
        talentMetadata: talentMatch?.sheetMetadata,
        talentDescription: talentMatch
          ? `This character must look exactly like ${talentMatch.talentName}`
          : undefined,
        styleConfig: input.styleConfig,
      };

      const childResult = await spawnAndAwaitChild<
        CharacterSheetWorkflowInput,
        CharacterSheetWorkflowResult
      >(step, {
        binding: characterSheetBinding,
        parentBindingName: PARENT_BINDING_NAME,
        parentInstanceId: event.instanceId,
        childId: `character-sheet:${characterDbId}`,
        childPayload,
        spawnStepName: `spawn-character-sheet-${index}`,
        awaitStepName: `await-character-sheet-${index}`,
        timeout: '30 minutes',
      });

      return {
        character,
        castingAttrs,
        characterDbId,
        childResult,
      };
    });

    const settled = await Promise.allSettled(spawnPromises);

    const seqCharacters: CharacterMinimal[] = [];
    for (const [index, outcome] of settled.entries()) {
      if (outcome.status === 'rejected') {
        // Log the per-child failure but do not throw — Promise.allSettled
        // ensures one timed-out / failed child cannot tank the parent. The
        // child's own `onFailure` already wrote the failed status + emitted
        // the realtime event for the affected character row.
        const character = input.characterBible[index];
        logger.error(
          `[CharacterBibleWorkflow:cf] Child character-sheet failed for ${character?.name ?? `index ${index}`}:`,
          {
            err: outcome.reason,
          }
        );
        continue;
      }

      const { character, castingAttrs, characterDbId, childResult } =
        outcome.value;

      seqCharacters.push({
        id: characterDbId,
        characterId: character.characterId,
        name: character.name,
        sheetImageUrl: childResult.sheetImageUrl,
        sheetStatus: 'completed' as const,
        sheetInputHash: null,
        physicalDescription:
          castingAttrs?.physicalDescription ?? character.physicalDescription,
        consistencyTag:
          castingAttrs?.consistencyTag ?? character.consistencyTag,
      });
    }

    return seqCharacters;
  }

  protected override onFailure({
    error,
  }: {
    event: Readonly<WorkflowEvent<CharacterBibleWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): void {
    logger.error(
      `[CharacterBibleWorkflow:cf] Character sheet generation failed: ${error}`
    );
  }
}
