/**
 * Cloudflare Workflows port of `talentMatchingWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/talent-matching-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` instead of `context.requestPayload`.
 *
 * The LLM call goes through `durableLLMCallCf`; see
 * `src/lib/workflows/llm-call-helper.ts`.
 */

import { talentMatchResponseSchema } from '@/lib/ai/response-schemas';
import { buildMatchingPromptVariables } from '@/lib/ai/talent-matching-prompt';
import type { ScopedDb } from '@/lib/db/scoped';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { durableLLMCallCf } from '@/lib/workflows/llm-call-helper';
import { waitForTalentSheets } from '@/lib/workflows/wait-for-sheets';
import type {
  TalentCharacterMatch,
  TalentMatchingWorkflowInput,
  TalentMatchingWorkflowOutput,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'talent-matching']);

export class TalentMatchingWorkflow extends OpenStoryWorkflowEntrypoint<TalentMatchingWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<TalentMatchingWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<TalentMatchingWorkflowOutput> {
    const input = event.payload;
    const { suggestedTalentIds, sequenceId, analysisModelId } = input;

    // Use pre-extracted bible from scene splitting (always provided by upstream)
    const characterBible = input.characterBible;

    // Talent matching only runs against pre-selected talent IDs. Characters
    // without a pre-cast talent are auto-extracted later in the pipeline and
    // given AI-generated portraits — that path never waits for sheets.
    //
    // For PRE-CAST talent, though, we DO need the casting reference: the
    // matches below read `defaultSheet?.imageUrl`. Talent the user just added
    // while creating this sequence may still be generating their sheet in the
    // fire-and-forget `/library-talent-sheet` workflow, so wait (bounded) for
    // those sheets before reading them — otherwise the cast character is
    // generated with an empty reference and won't look like the chosen talent.
    if (suggestedTalentIds?.length && input.teamId) {
      await waitForTalentSheets(step, scopedDb, suggestedTalentIds, {
        // Surface the wait in the generation progress dialog. Phase 2 is the
        // "Casting characters & locations…" step; only emitted when we actually
        // have to wait, so a ready library never flashes a spurious status.
        onWaitNeeded: async () => {
          if (!sequenceId) return;
          await getGenerationChannel(sequenceId).emit(
            'generation.phase:start',
            {
              phase: 2,
              phaseName: 'Waiting for talent sheets…',
            }
          );
        },
      });
    }

    const { talentList, matchingPromptVariables } = await step.do(
      'get-talent-list',
      async () => {
        if (!suggestedTalentIds?.length || !input.teamId) {
          return { talentList: [], matchingPromptVariables: {} };
        }
        const talentList = await scopedDb.talent.getByIds(suggestedTalentIds);
        return {
          talentList,
          matchingPromptVariables: buildMatchingPromptVariables(
            characterBible,
            talentList
          ),
        };
      }
    );

    const { matches: talentMatches } =
      talentList.length > 0
        ? await durableLLMCallCf(
            step,
            {
              name: 'talent-matching',
              phase: { number: 2, name: 'Matching talent…' },
              promptName: 'phase/talent-matching-chat',
              promptVariables: matchingPromptVariables,
              modelId: analysisModelId,
              responseSchema: talentMatchResponseSchema,
            },
            {
              sequenceId,
              userId: input.userId,
              workflowRunId: event.instanceId,
              scopedDb,
            }
          )
        : { matches: [] as Array<{ characterId: string; talentId: string }> };

    const talentCharacterMatches: TalentCharacterMatch[] = await step.do(
      'build-matches',
      async () => {
        const usedTalentIds = new Set<string>();
        const matches: TalentCharacterMatch[] = [];

        for (const match of talentMatches) {
          // Ensure each talent is only cast once (but characters can have multiple talents
          // when there are more talents than characters)
          if (usedTalentIds.has(match.talentId)) {
            logger.warn(
              `[TalentMatchingWorkflow:cf] Skipping duplicate talent ${match.talentId}`
            );
            continue;
          }

          const talent = talentList.find((t) => t.id === match.talentId);
          if (!talent) {
            logger.warn(
              `[TalentMatchingWorkflow:cf] Talent ${match.talentId} not found in list`
            );
            continue;
          }

          const character = characterBible.find(
            (c) => c.characterId === match.characterId
          );
          if (!character) {
            logger.warn(
              `[TalentMatchingWorkflow:cf] Character ${match.characterId} not found in bible`
            );
            continue;
          }

          usedTalentIds.add(match.talentId);
          matches.push({
            characterId: match.characterId,
            talentId: match.talentId,
            talentName: talent.name,
            sheetImageUrl: talent.defaultSheet?.imageUrl ?? '',
            sheetMetadata: talent.defaultSheet?.metadata ?? undefined,
          });
        }

        if (matches.length > 0) {
          await getGenerationChannel(sequenceId).emit(
            'generation.talent:matched',
            {
              matches: matches.map((m) => {
                const char = characterBible.find(
                  (c) => c.characterId === m.characterId
                );
                return {
                  characterId: m.characterId,
                  characterName: char?.name ?? m.characterId,
                  talentId: m.talentId,
                  talentName: m.talentName,
                };
              }),
            }
          );
        }

        return matches;
      }
    );

    return {
      matches: talentCharacterMatches,
    };
  }
}
