/**
 * Scoped Frame Prompt Versions Sub-module (image / visual prompt history).
 *
 * Appends a revision to `frame_prompt_versions` and mirrors the current value
 * onto the frame: `frames.imagePrompt` (text), `frames.visualPromptInputHash`
 * (staleness), and the `frames.selectedImagePromptVersionId` pointer. The
 * frame-side sibling of `shot_prompt_versions` (motion prompt).
 *
 * Like the shot-prompt path, the append + mirror pair is sequential, not
 * transactional: the version row is the source of truth and the cached columns
 * are a read-path optimization. AI rows dedupe on the partial unique index
 * `(frame_id, input_hash) WHERE input_hash IS NOT NULL AND source != 'restored'`
 * so workflow retries don't double-append; a force-regen against unchanged
 * inputs falls back to a null-hash row so the new text still lands in history.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § prompt versioning and docs/architecture/scene-shot-frame-redesign.md.
 */

import type { VisualPromptComponents } from '@/lib/ai/scene-analysis.schema';
import type { Database } from '@/lib/db/client';
import { framePromptVersions, frames, user } from '@/lib/db/schema';
import type { FramePromptVersion } from '@/lib/db/schema';
import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { buildEventInsert } from './sequence-events';

type WriteFramePromptVersionBase = {
  frameId: string;
  text: string;
  components?: VisualPromptComponents | null;
  createdBy?: string | null;
};

/**
 * `inputHash` is the upstream context (scene + style + narrowed bibles +
 * aspectRatio + analysisModel) the prompt aligns with. AI / regenerated rows
 * must carry a real hash + analysis model so the cached
 * `visual_prompt_input_hash` keeps staleness detection alive; user-edits and
 * restores may carry null when context was uncomputable. Restores carry the
 * source version's hash + model verbatim so restoring an old AI prompt does
 * not silently disable staleness.
 */
export type WriteFramePromptVersionInput = WriteFramePromptVersionBase &
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

export function createFramePromptVersionsMethods(db: Database) {
  /** Point the frame at `version` and mirror its text/hash onto the frame. */
  const mirrorOntoFrame = (frameId: string, version: FramePromptVersion) =>
    db
      .update(frames)
      .set({
        imagePrompt: version.text,
        visualPromptInputHash: version.inputHash,
        selectedImagePromptVersionId: version.id,
        updatedAt: new Date(),
      })
      .where(eq(frames.id, frameId));

  const methods = {
    /**
     * Append a prompt version and mirror it onto the frame (text, hash, and
     * the selected-pointer). Returns the inserted (or pre-existing matching)
     * row. See the module docstring for the dedupe / force-regen contract.
     */
    write: async (
      input: WriteFramePromptVersionInput
    ): Promise<FramePromptVersion> => {
      const nextHash = input.inputHash;
      const analysisModel = input.analysisModel;

      const [inserted] = await db
        .insert(framePromptVersions)
        .values({
          frameId: input.frameId,
          text: input.text,
          components: input.components,
          source: input.source,
          inputHash: nextHash,
          analysisModel,
          createdBy: input.createdBy ?? null,
        })
        .onConflictDoNothing()
        .returning();

      let version: FramePromptVersion | undefined = inserted;
      if (!version && nextHash !== null) {
        const [existing] = await db
          .select()
          .from(framePromptVersions)
          .where(
            and(
              eq(framePromptVersions.frameId, input.frameId),
              eq(framePromptVersions.inputHash, nextHash)
            )
          )
          .limit(1);

        if (existing && existing.text !== input.text) {
          // Same upstream hash, genuinely new text. Two ways to get here: a
          // force-regen (AI runs against unchanged inputs) or a user-edit whose
          // live hash matches the row it edits. Either way the new text must
          // land in history, so bypass the partial unique index with a null
          // input_hash; the cached hash below still tracks the real context.
          // (`restored` rows never reach this branch — the index excludes them,
          // so their insert never conflicts.)
          const [forced] = await db
            .insert(framePromptVersions)
            .values({
              frameId: input.frameId,
              text: input.text,
              components: input.components,
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
        throw new Error('Failed to insert frame prompt version');
      }

      await db
        .update(frames)
        .set({
          imagePrompt: input.text,
          visualPromptInputHash: nextHash,
          selectedImagePromptVersionId: version.id,
          updatedAt: new Date(),
        })
        .where(eq(frames.id, input.frameId));

      return version;
    },

    /**
     * Append an AI-generated visual prompt version, deciding `ai-generated`
     * (first version for the frame) vs `regenerated` (a re-run) from the
     * frame's existing history — so callers (the generation workflow) don't
     * compute `source` or chase `getLatest` themselves. Appends + mirrors via
     * `write`. The dedupe/force-regen contract is `write`'s.
     */
    writeAiVersion: async (input: {
      frameId: string;
      text: string;
      components?: VisualPromptComponents | null;
      inputHash: string;
      analysisModel: string;
      createdBy?: string | null;
    }): Promise<FramePromptVersion> => {
      const previous = await methods.getLatest(input.frameId);
      return methods.write({
        ...input,
        source: previous ? 'regenerated' : 'ai-generated',
      });
    },

    /**
     * Repoint the frame at an existing prompt version (a restore) and mirror
     * it onto the frame, committing the change and a `prompt.selected` event
     * in one batch. Returns the selected version.
     */
    select: async (
      frameId: string,
      versionId: string,
      opts: { actorId: string | null }
    ): Promise<FramePromptVersion> => {
      const [version] = await db
        .select()
        .from(framePromptVersions)
        .where(
          and(
            eq(framePromptVersions.id, versionId),
            eq(framePromptVersions.frameId, frameId)
          )
        );
      if (!version) {
        throw new Error(
          `FramePromptVersion ${versionId} not found for frame ${frameId}`
        );
      }
      const [frame] = await db
        .select({
          sequenceId: frames.sequenceId,
          prev: frames.selectedImagePromptVersionId,
        })
        .from(frames)
        .where(eq(frames.id, frameId));
      if (!frame) {
        throw new Error(`Frame ${frameId} not found`);
      }

      await db.batch([
        mirrorOntoFrame(frameId, version),
        buildEventInsert(db, {
          sequenceId: frame.sequenceId,
          actorId: opts.actorId,
          kind: 'prompt.selected',
          targetType: 'frame',
          targetId: frameId,
          summary: 'Restored image prompt',
          data: { versionId, prevVersionId: frame.prev ?? null },
        }),
      ]);
      return version;
    },

    /** Revision history for a frame's image prompt, newest first. */
    listByFrame: async (frameId: string): Promise<FramePromptVersion[]> => {
      return await db
        .select()
        .from(framePromptVersions)
        .where(eq(framePromptVersions.frameId, frameId))
        .orderBy(desc(framePromptVersions.createdAt));
    },

    /** History list for the UI — joins author name. Newest first. */
    listByFrameWithAuthor: async (
      frameId: string
    ): Promise<
      Array<FramePromptVersion & { createdByName: string | null }>
    > => {
      const rows = await db
        .select({ version: framePromptVersions, createdByName: user.name })
        .from(framePromptVersions)
        .leftJoin(user, eq(framePromptVersions.createdBy, user.id))
        .where(eq(framePromptVersions.frameId, frameId))
        .orderBy(desc(framePromptVersions.createdAt));
      return rows.map((r) => ({
        ...r.version,
        createdByName: r.createdByName,
      }));
    },

    /** Fetch a single version scoped to its frame. */
    getByIdForFrame: async (
      versionId: string,
      frameId: string
    ): Promise<FramePromptVersion | null> => {
      const [row] = await db
        .select()
        .from(framePromptVersions)
        .where(
          and(
            eq(framePromptVersions.id, versionId),
            eq(framePromptVersions.frameId, frameId)
          )
        )
        .limit(1);
      return row ?? null;
    },

    /** Most recent version, or null. */
    getLatest: async (frameId: string): Promise<FramePromptVersion | null> => {
      const [row] = await db
        .select()
        .from(framePromptVersions)
        .where(eq(framePromptVersions.frameId, frameId))
        .orderBy(desc(framePromptVersions.createdAt))
        .limit(1);
      return row ?? null;
    },

    /**
     * Most recent version with a non-null `inputHash` — the staleness path's
     * reference for frames whose cached hash was nulled by a context-less
     * user-edit. Mirrors `shotPromptVersions.getLatestWithInputHash`.
     */
    getLatestWithInputHash: async (
      frameId: string
    ): Promise<FramePromptVersion | null> => {
      const [row] = await db
        .select()
        .from(framePromptVersions)
        .where(
          and(
            eq(framePromptVersions.frameId, frameId),
            isNotNull(framePromptVersions.inputHash)
          )
        )
        .orderBy(desc(framePromptVersions.createdAt))
        .limit(1);
      return row ?? null;
    },
  };
  return methods;
}
