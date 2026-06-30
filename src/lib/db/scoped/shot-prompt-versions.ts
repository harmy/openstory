/**
 * Scoped Shot Prompt Versions Sub-module
 *
 * Appends a new revision row to `shot_prompt_versions` and updates the
 * cached pointer column on `shots` (`imagePrompt` for visual prompts,
 * `motionPrompt` for motion prompts) plus the matching
 * `*_prompt_input_hash` column. The two writes are sequential, not
 * transactional — see `write` for the durability story.
 *
 * Callers go through these helpers instead of writing the cached column
 * directly so prompt history is never lost. Read-path (read the cached
 * column) is unchanged. Renamed from `shot-prompt-variants` in #988.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § prompt versioning.
 */

import type {
  MotionAudio,
  MotionDialogue,
  MotionPromptParameters,
} from '@/lib/ai/scene-analysis.schema';
import type { Database } from '@/lib/db/client';
import { shotPromptVersions, shots, user } from '@/lib/db/schema';
import type {
  ShotPromptType,
  ShotPromptVersion,
  ShotPromptVersionComponents,
} from '@/lib/db/schema';
import { and, desc, eq, inArray, isNotNull, lte } from 'drizzle-orm';
import { buildEventInsert } from './sequence-events';

type WriteShotPromptVersionBase = {
  shotId: string;
  promptType: ShotPromptType;
  text: string;
  components?: ShotPromptVersionComponents | null;
  parameters?: MotionPromptParameters | null;
  /**
   * Motion-only: the scene dialogue/audio direction the prompt was authored
   * with. Persisted on the version so audio-capable video models can append
   * them at render time without re-reading `metadata.prompts.motion` (#713).
   */
  dialogue?: MotionDialogue | null;
  audio?: MotionAudio | null;
  createdBy?: string | null;
};

/**
 * `inputHash` represents the upstream context (scene + style + narrowed
 * bibles + aspectRatio + analysisModel) that this prompt is aligned with,
 * regardless of who authored the text. AI-generated and regenerated rows
 * carry a real hash at the call site so the partial unique index can dedupe
 * retries; the helper may downgrade the persisted hash to null on
 * the force-regen fallback path (see `write` for details). User-edits also
 * carry the live hash captured at edit time so staleness detection keeps
 * working after a hand-typed prompt; null is permitted only when the
 * upstream context was uncomputable at write time (e.g. style deleted), in
 * which case the staleness function falls back to an earlier non-null row.
 *
 * Restored rows carry the source version's hash + analysisModel verbatim so
 * the cached `*_prompt_input_hash` column keeps tracking the upstream context
 * that originally produced the prompt — restoring an old AI prompt must NOT
 * silently disable staleness detection. Both fields stay nullable for restored
 * rows to accommodate legacy user-edit rows written before this contract
 * landed (they have null hashes that we can't retroactively recompute).
 */
export type WriteShotPromptVersionInput = WriteShotPromptVersionBase &
  (
    | {
        source: 'ai-generated' | 'regenerated';
        inputHash: string;
        analysisModel: string;
      }
    | {
        source: 'user-edit';
        inputHash: string | null;
        analysisModel: string | null;
      }
    | {
        source: 'restored';
        inputHash: string | null;
        analysisModel: string | null;
      }
  );

const cachedColumnsForType = (promptType: ShotPromptType) => {
  // Visual (image) prompt versions moved to `frame_prompt_versions` (#989) — the
  // cached mirror lives on the anchor frame, not `shots`. Only the MOTION prompt
  // still mirrors onto `shots`.
  if (promptType === 'visual') {
    throw new Error(
      'Visual prompt versions moved to frame_prompt_versions (#989); use scopedDb.framePromptVersions'
    );
  }
  return {
    text: shots.motionPrompt,
    hash: shots.motionPromptInputHash,
    textKey: 'motionPrompt' as const,
    hashKey: 'motionPromptInputHash' as const,
  };
};

export function createShotPromptVersionsMethods(db: Database) {
  /**
   * Point the shot at `version` and mirror its text/hash onto the shot. The
   * `selectedMotionPromptVersionId` pointer is what the render manifest
   * references (motion prompt version snapshot, #990) — keeping it in lockstep
   * with the cached text/hash is load-bearing.
   */
  const mirrorOntoShot = (shotId: string, version: ShotPromptVersion) =>
    db
      .update(shots)
      .set({
        motionPrompt: version.text,
        motionPromptInputHash: version.inputHash,
        selectedMotionPromptVersionId: version.id,
        updatedAt: new Date(),
      })
      .where(eq(shots.id, shotId));

  const methods = {
    /**
     * Append a new prompt version row and update the cached pointer on
     * `shots`. Returns the inserted (or pre-existing matching) row.
     *
     * Durability: the insert + update pair is sequential, not transactional.
     * The version row is the source of truth; the cached column on `shots`
     * is a read-path optimization. To make retries safe, AI-generated
     * rows are deduped by the unique partial index on
     * `(shot_id, prompt_type, input_hash) WHERE input_hash IS NOT NULL AND
     * source != 'restored'`: an insert that conflicts with an existing row
     * no-ops, the existing row is fetched, and the cached pointer is updated as
     * normal. (The `source != 'restored'` clause is load-bearing — it lets a
     * restore append an audit row even when its hash matches an existing one.)
     *
     * Force-regeneration corner case: an explicit user-triggered regen runs
     * the LLM against unchanged upstream inputs. The new completion's hash
     * matches an existing row, so the unique-index insert no-ops — but the
     * text genuinely differs. We append a fallback row with `input_hash =
     * NULL` (excluded by the partial index) so history records the new text;
     * the cached `*_prompt_input_hash` column still tracks the real
     * `liveHash` so staleness detection stays correct.
     */
    write: async (
      input: WriteShotPromptVersionInput
    ): Promise<ShotPromptVersion> => {
      const cached = cachedColumnsForType(input.promptType);

      const nextHash = input.inputHash;
      const analysisModel = input.analysisModel;

      // Append first so a crash can't leave a stale pointer with no row
      // behind it. The reverse order would be unrecoverable.
      const [inserted] = await db
        .insert(shotPromptVersions)
        .values({
          shotId: input.shotId,
          promptType: input.promptType,
          text: input.text,
          components: input.components,
          parameters: input.parameters,
          dialogue: input.dialogue,
          audio: input.audio,
          source: input.source,
          inputHash: nextHash,
          analysisModel,
          createdBy: input.createdBy ?? null,
        })
        .onConflictDoNothing()
        .returning();

      let version: ShotPromptVersion | undefined = inserted;
      if (!version && nextHash !== null) {
        const [existing] = await db
          .select()
          .from(shotPromptVersions)
          .where(
            and(
              eq(shotPromptVersions.shotId, input.shotId),
              eq(shotPromptVersions.promptType, input.promptType),
              eq(shotPromptVersions.inputHash, nextHash)
            )
          )
          .limit(1);

        if (existing && existing.text !== input.text) {
          // Same upstream hash but genuinely new text. Two ways to get here: a
          // force-regen (AI runs against unchanged inputs) or a user-edit whose
          // live hash matches the row it edits. Either way the new text must
          // land in history, so bypass the partial unique index with a null
          // `input_hash`; the cached hash below still tracks the real `liveHash`
          // so staleness detection stays correct. (`restored` rows never reach
          // this branch — the partial index excludes them, so they never
          // conflict on insert.)
          const [forced] = await db
            .insert(shotPromptVersions)
            .values({
              shotId: input.shotId,
              promptType: input.promptType,
              text: input.text,
              components: input.components,
              parameters: input.parameters,
              dialogue: input.dialogue,
              audio: input.audio,
              source: input.source,
              inputHash: null,
              analysisModel,
              createdBy: input.createdBy ?? null,
            })
            .returning();
          version = forced;
        } else {
          version = existing;
        }
      }

      if (!version) {
        throw new Error('Failed to insert shot prompt version');
      }

      // Mirror onto the shot AND repoint the selection at this version. The
      // `selectedMotionPromptVersionId` pointer was previously never set, so the
      // render manifest snapshotted a null motion-prompt reference (#990 bug);
      // setting it here is load-bearing. Note the cached hash tracks `nextHash`
      // (the real upstream context) even on the force-regen path where the
      // version row itself carries a null hash — see the branch above.
      await db
        .update(shots)
        .set({
          [cached.textKey]: input.text,
          [cached.hashKey]: nextHash,
          selectedMotionPromptVersionId: version.id,
          updatedAt: new Date(),
        })
        .where(eq(shots.id, input.shotId));

      return version;
    },

    /**
     * Append an AI-generated MOTION prompt version, deciding `ai-generated`
     * (first motion version for the shot) vs `regenerated` (a re-run) from the
     * shot's existing motion history — so the generation workflow doesn't
     * compute `source` or chase `getLatest` itself. Appends + mirrors via
     * `write`. The dedupe/force-regen contract is `write`'s.
     */
    writeAiVersion: async (input: {
      shotId: string;
      text: string;
      components?: ShotPromptVersionComponents | null;
      parameters?: MotionPromptParameters | null;
      dialogue?: MotionDialogue | null;
      audio?: MotionAudio | null;
      inputHash: string;
      analysisModel: string;
      createdBy?: string | null;
    }): Promise<ShotPromptVersion> => {
      const previous = await methods.getLatest(input.shotId, 'motion');
      return methods.write({
        ...input,
        promptType: 'motion',
        source: previous ? 'regenerated' : 'ai-generated',
      });
    },

    /**
     * The motion prompt version the shot currently points at via
     * `shots.selectedMotionPromptVersionId`, or null. This is the resolution
     * source of truth (#713): the render path reconstructs the `MotionPrompt`
     * from this row rather than reading `metadata.prompts.motion`.
     */
    getSelectedMotion: async (
      shotId: string
    ): Promise<ShotPromptVersion | null> => {
      const [row] = await db
        .select({ version: shotPromptVersions })
        .from(shots)
        .innerJoin(
          shotPromptVersions,
          eq(shots.selectedMotionPromptVersionId, shotPromptVersions.id)
        )
        .where(eq(shots.id, shotId))
        .limit(1);
      return row?.version ?? null;
    },

    /**
     * Selected motion prompt version for each shot, keyed by shotId. Powers the
     * read-side projection that feeds the client motion preview (the structured
     * dialogue/audio data the assembled preview needs). Shots with no selected
     * motion version are absent from the map.
     */
    getSelectedMotionByShots: async (
      shotIds: string[]
    ): Promise<Map<string, ShotPromptVersion>> => {
      if (shotIds.length === 0) return new Map();
      const rows = await db
        .select({ shotId: shots.id, version: shotPromptVersions })
        .from(shots)
        .innerJoin(
          shotPromptVersions,
          eq(shots.selectedMotionPromptVersionId, shotPromptVersions.id)
        )
        .where(inArray(shots.id, shotIds));
      return new Map(rows.map((r) => [r.shotId, r.version]));
    },

    /**
     * Repoint the shot at an existing motion prompt version (a restore / undo)
     * and mirror it onto the shot, committing the change and a
     * `prompt.selected` event in one batch. Returns the selected version.
     * Mirrors `framePromptVersions.select`.
     */
    select: async (
      shotId: string,
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<ShotPromptVersion> => {
      const [version] = await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.id, versionId),
            eq(shotPromptVersions.shotId, shotId),
            eq(shotPromptVersions.promptType, 'motion')
          )
        );
      if (!version) {
        throw new Error(
          `Motion ShotPromptVersion ${versionId} not found for shot ${shotId}`
        );
      }
      const [shot] = await db
        .select({
          sequenceId: shots.sequenceId,
          prev: shots.selectedMotionPromptVersionId,
        })
        .from(shots)
        .where(eq(shots.id, shotId));
      if (!shot) {
        throw new Error(`Shot ${shotId} not found`);
      }

      await db.batch([
        mirrorOntoShot(shotId, version),
        buildEventInsert(db, {
          sequenceId: shot.sequenceId,
          actorId: opts.actorId,
          kind: 'prompt.selected',
          targetType: 'shot',
          targetId: shotId,
          summary: 'Restored motion prompt',
          data: { versionId, prevVersionId: shot.prev ?? null },
        }),
      ]);
      return version;
    },

    /** List the revision history for a shot's prompt, newest first. */
    listByShot: async (
      shotId: string,
      promptType: ShotPromptType
    ): Promise<ShotPromptVersion[]> => {
      return await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.shotId, shotId),
            eq(shotPromptVersions.promptType, promptType)
          )
        )
        .orderBy(desc(shotPromptVersions.createdAt));
    },

    /**
     * History list for the UI — joins author name. Newest first.
     */
    listByShotWithAuthor: async (
      shotId: string,
      promptType: ShotPromptType
    ): Promise<Array<ShotPromptVersion & { createdByName: string | null }>> => {
      const rows = await db
        .select({ version: shotPromptVersions, createdByName: user.name })
        .from(shotPromptVersions)
        .leftJoin(user, eq(shotPromptVersions.createdBy, user.id))
        .where(
          and(
            eq(shotPromptVersions.shotId, shotId),
            eq(shotPromptVersions.promptType, promptType)
          )
        )
        .orderBy(desc(shotPromptVersions.createdAt));
      return rows.map((r) => ({
        ...r.version,
        createdByName: r.createdByName,
      }));
    },

    /** Fetch a single version scoped to its shot. */
    getByIdForShot: async (
      versionId: string,
      shotId: string
    ): Promise<ShotPromptVersion | null> => {
      const [row] = await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.id, versionId),
            eq(shotPromptVersions.shotId, shotId)
          )
        )
        .limit(1);
      return row ?? null;
    },

    /**
     * Candidates for matching a `shot_variants.promptHash` (`simpleHash` of
     * the prompt text) — pulls prompt versions of the right type that existed
     * at or before `cutoff`, newest first. Caller filters by simpleHash.
     */
    listCandidatesAtOrBefore: async (
      shotId: string,
      promptType: ShotPromptType,
      cutoff: Date,
      limit = 50
    ): Promise<ShotPromptVersion[]> => {
      return await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.shotId, shotId),
            eq(shotPromptVersions.promptType, promptType),
            lte(shotPromptVersions.createdAt, cutoff)
          )
        )
        .orderBy(desc(shotPromptVersions.createdAt))
        .limit(limit);
    },

    /** Most recent version of a given type, or null if none exists. */
    getLatest: async (
      shotId: string,
      promptType: ShotPromptType
    ): Promise<ShotPromptVersion | null> => {
      const [row] = await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.shotId, shotId),
            eq(shotPromptVersions.promptType, promptType)
          )
        )
        .orderBy(desc(shotPromptVersions.createdAt))
        .limit(1);
      return row ?? null;
    },

    /**
     * Most recent version of a given type whose `inputHash` is non-null.
     * Used by the staleness path to find a reference hash for legacy shots
     * whose cached `*_prompt_input_hash` column was nulled out by a
     * pre-fix user-edit. Skips user-edit rows that fell back to null when
     * context was uncomputable.
     */
    getLatestWithInputHash: async (
      shotId: string,
      promptType: ShotPromptType
    ): Promise<ShotPromptVersion | null> => {
      const [row] = await db
        .select()
        .from(shotPromptVersions)
        .where(
          and(
            eq(shotPromptVersions.shotId, shotId),
            eq(shotPromptVersions.promptType, promptType),
            isNotNull(shotPromptVersions.inputHash)
          )
        )
        .orderBy(desc(shotPromptVersions.createdAt))
        .limit(1);
      return row ?? null;
    },
  };
  return methods;
}
