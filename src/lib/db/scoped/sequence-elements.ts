/**
 * Scoped Sequence Elements Sub-module
 * Element CRUD for per-sequence uploaded reference images.
 */

import type { Database } from '@/lib/db/client';
import type {
  ElementVisionStatus,
  Frame,
  NewSequenceElement,
  SequenceElement,
} from '@/lib/db/schema';
import { frames, sequenceElements, sequences } from '@/lib/db/schema';
import {
  buildFrameRenameDeltas,
  replaceTokenInText,
} from '@/lib/sequence-elements/cascade-rename';
import { matchElementsToScene } from '@/lib/workflows/scene-matching';
import { and, eq, inArray, like, ne, or, sql } from 'drizzle-orm';

export function createSequenceElementsMethods(db: Database) {
  const update = async (
    id: string,
    data: Partial<NewSequenceElement>
  ): Promise<SequenceElement> => {
    const [element] = await db
      .update(sequenceElements)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(sequenceElements.id, id))
      .returning();

    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB may return undefined
    if (!element) {
      throw new Error(`SequenceElement ${id} not found`);
    }

    return element;
  };

  const getByToken = async (
    sequenceId: string,
    token: string
  ): Promise<SequenceElement | null> => {
    const result = await db
      .select()
      .from(sequenceElements)
      .where(
        and(
          eq(sequenceElements.sequenceId, sequenceId),
          eq(sequenceElements.token, token)
        )
      );
    return result[0] ?? null;
  };

  return {
    getById: async (id: string): Promise<SequenceElement | null> => {
      const result = await db
        .select()
        .from(sequenceElements)
        .where(eq(sequenceElements.id, id));
      return result[0] ?? null;
    },

    getByToken,

    /**
     * Throws if `token` is already taken by another element in this sequence.
     * Use for user-driven renames where collisions must be surfaced; for
     * system-driven renames (vision auto-suggest), use ensureUniqueToken
     * which suffixes a `_N` instead.
     */
    isTokenTaken: async (
      sequenceId: string,
      token: string,
      excludeElementId?: string
    ): Promise<boolean> => {
      const whereClauses = [
        eq(sequenceElements.sequenceId, sequenceId),
        eq(sequenceElements.token, token),
      ];
      if (excludeElementId) {
        whereClauses.push(ne(sequenceElements.id, excludeElementId));
      }
      const rows = await db
        .select({ id: sequenceElements.id })
        .from(sequenceElements)
        .where(and(...whereClauses));
      return rows.length > 0;
    },

    ensureUniqueToken: async (
      sequenceId: string,
      token: string
    ): Promise<string> => {
      // Escape LIKE wildcards (%, _, \) so `foo_bar` doesn't match `foo1bar`.
      const escaped = token.replace(/[\\%_]/g, (c) => `\\${c}`);
      const rows = await db
        .select({ token: sequenceElements.token })
        .from(sequenceElements)
        .where(
          and(
            eq(sequenceElements.sequenceId, sequenceId),
            or(
              eq(sequenceElements.token, token),
              like(sequenceElements.token, sql`${`${escaped}\\_%`} ESCAPE '\\'`)
            )
          )
        );

      const taken = new Set(rows.map((r) => r.token));
      if (!taken.has(token)) return token;

      // Hard cap — 100 is well above any realistic upload-of-same-name count
      // and bounds the worst-case query path.
      for (let suffix = 2; suffix <= 100; suffix += 1) {
        const candidate = `${token}_${suffix}`;
        if (!taken.has(candidate)) return candidate;
      }
      throw new Error('Unable to generate unique element token');
    },

    list: async (sequenceId: string): Promise<SequenceElement[]> => {
      return await db
        .select()
        .from(sequenceElements)
        .where(eq(sequenceElements.sequenceId, sequenceId))
        .orderBy(sequenceElements.createdAt);
    },

    listByIds: async (ids: string[]): Promise<SequenceElement[]> => {
      if (ids.length === 0) return [];
      return await db
        .select()
        .from(sequenceElements)
        .where(inArray(sequenceElements.id, ids));
    },

    create: async (data: NewSequenceElement): Promise<SequenceElement> => {
      const [element] = await db
        .insert(sequenceElements)
        .values(data)
        .returning();
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB may return undefined
      if (!element) {
        throw new Error('Failed to insert sequence element');
      }
      return element;
    },

    update,

    updateVisionStatus: async (
      id: string,
      status: ElementVisionStatus,
      error?: string
    ): Promise<SequenceElement> => {
      return await update(id, {
        visionStatus: status,
        visionError: error ?? null,
        ...(status === 'completed' && { visionGeneratedAt: new Date() }),
      });
    },

    updateVisionResult: async (
      id: string,
      description: string,
      consistencyTag: string
    ): Promise<SequenceElement> => {
      return await update(id, {
        description,
        consistencyTag,
        visionStatus: 'completed',
        visionGeneratedAt: new Date(),
        visionError: null,
      });
    },

    updateFirstMention: async (
      id: string,
      firstMention: {
        sceneId: string;
        text: string;
        lineNumber: number;
      }
    ): Promise<SequenceElement> => {
      return await update(id, {
        firstMentionSceneId: firstMention.sceneId,
        firstMentionText: firstMention.text,
        firstMentionLine: firstMention.lineNumber,
      });
    },

    /**
     * Rename an element's token and rewrite every reference to the old token
     * across the sequence: `sequences.script`, per-frame `metadata` (continuity
     * tags, originalScript extract, prompt strings) and the user-edit
     * `imagePrompt`/`motionPrompt` overrides on `frames`.
     *
     * Returns the affected counts so callers can surface a meaningful toast
     * ("Renamed LOGO → BRAND across 5 frames + script"). The caller is
     * expected to have already validated uniqueness of `newToken` within the
     * sequence — this method does not check collisions.
     */
    cascadeRename: async (args: {
      sequenceId: string;
      elementId: string;
      oldToken: string;
      newToken: string;
    }): Promise<{
      element: SequenceElement;
      framesUpdated: number;
      scriptUpdated: boolean;
    }> => {
      const { sequenceId, elementId, oldToken, newToken } = args;
      const element = await update(elementId, { token: newToken });

      if (oldToken === newToken) {
        return { element, framesUpdated: 0, scriptUpdated: false };
      }

      let scriptUpdated = false;
      const [sequenceRow] = await db
        .select({ script: sequences.script })
        .from(sequences)
        .where(eq(sequences.id, sequenceId));
      if (sequenceRow?.script) {
        const rewritten = replaceTokenInText(
          sequenceRow.script,
          oldToken,
          newToken
        );
        if (rewritten !== sequenceRow.script) {
          await db
            .update(sequences)
            .set({ script: rewritten, updatedAt: new Date() })
            .where(eq(sequences.id, sequenceId));
          scriptUpdated = true;
        }
      }

      const allFrames = (await db
        .select()
        .from(frames)
        .where(eq(frames.sequenceId, sequenceId))) as Frame[];
      const deltas = buildFrameRenameDeltas(allFrames, oldToken, newToken);
      for (const delta of deltas) {
        const set: Record<string, unknown> = { updatedAt: new Date() };
        if (delta.metadata !== undefined) set.metadata = delta.metadata;
        if (delta.imagePrompt !== undefined)
          set.imagePrompt = delta.imagePrompt;
        if (delta.motionPrompt !== undefined)
          set.motionPrompt = delta.motionPrompt;
        await db.update(frames).set(set).where(eq(frames.id, delta.frameId));
      }

      return { element, framesUpdated: deltas.length, scriptUpdated };
    },

    delete: async (id: string): Promise<boolean> => {
      const result = await db
        .delete(sequenceElements)
        .where(eq(sequenceElements.id, id));
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined
      return (result.rowsAffected ?? 0) > 0;
    },

    getFrameIdsForElement: async (
      sequenceId: string,
      elementId: string
    ): Promise<string[]> => {
      const elementResult = await db
        .select()
        .from(sequenceElements)
        .where(eq(sequenceElements.id, elementId));
      const element = elementResult[0] ?? null;
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
      if (!element || element.sequenceId !== sequenceId) {
        return [];
      }

      const allFrames = await db
        .select()
        .from(frames)
        .where(eq(frames.sequenceId, sequenceId));

      return (allFrames as Frame[])
        .filter((frame) => {
          const elementTags = frame.metadata?.continuity?.elementTags ?? [];
          const sceneScript = frame.metadata?.originalScript?.extract ?? '';
          return (
            matchElementsToScene([element], elementTags, sceneScript).length > 0
          );
        })
        .map((f) => f.id);
    },

    /**
     * Frame counts for *all* elements in a sequence, computed in a single
     * scan over frames + elements. The elements grid renders N cards, each
     * of which previously called `getFrameIdsForElement` — an N+1 over the
     * full frame set. Returns an `elementId → count` map; elements with zero
     * matches are pre-seeded so the grid can render `Used in 0 frames`
     * instead of `undefined`.
     */
    getFrameCountsByElement: async (
      sequenceId: string
    ): Promise<Record<string, { frameCount: number; videoCount: number }>> => {
      const allElements = await db
        .select()
        .from(sequenceElements)
        .where(eq(sequenceElements.sequenceId, sequenceId));
      const counts: Record<string, { frameCount: number; videoCount: number }> =
        {};
      for (const el of allElements) {
        counts[el.id] = { frameCount: 0, videoCount: 0 };
      }
      if (allElements.length === 0) return counts;

      const allFrames = await db
        .select()
        .from(frames)
        .where(eq(frames.sequenceId, sequenceId));

      for (const frame of allFrames as Frame[]) {
        const elementTags = frame.metadata?.continuity?.elementTags ?? [];
        const sceneScript = frame.metadata?.originalScript.extract ?? '';
        const matched = matchElementsToScene(
          allElements,
          elementTags,
          sceneScript
        );
        const hasVideo = !!frame.videoUrl;
        for (const el of matched) {
          const entry = counts[el.id];
          if (!entry) continue;
          entry.frameCount += 1;
          if (hasVideo) entry.videoCount += 1;
        }
      }
      return counts;
    },
  };
}
