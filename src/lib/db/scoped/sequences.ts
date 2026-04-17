/**
 * Scoped Sequences Sub-module
 * Team-scoped sequence CRUD and per-sequence update methods.
 */

import {
  type AspectRatio,
  DEFAULT_ASPECT_RATIO,
} from '@/lib/constants/aspect-ratios';
import type { Database } from '@/lib/db/client';
import { sequences } from '@/lib/db/schema';
import type { Frame, NewSequence, Sequence, Style } from '@/lib/db/schema';
import type {
  MergedVideoStatus,
  MusicStatus,
  SequenceStatus,
} from '@/lib/db/schema/sequences';
import { ValidationError } from '@/lib/errors';
import { and, desc, eq, not } from 'drizzle-orm';

export type MusicFieldsUpdate = {
  musicStatus?: MusicStatus;
  musicModel?: string;
  musicError?: string | null;
  musicUrl?: string;
  musicPath?: string;
  musicGeneratedAt?: Date;
};

export type MergedVideoFieldsUpdate = {
  mergedVideoStatus?: MergedVideoStatus;
  mergedVideoError?: string | null;
  mergedVideoUrl?: string | null;
  mergedVideoPath?: string | null;
  mergedVideoGeneratedAt?: Date;
};

type SequenceWithFrames = Sequence & {
  frames: Frame[];
  style: Style | null;
};

export function createSequencesReadMethods(db: Database, teamId: string) {
  return {
    list: async (): Promise<Sequence[]> => {
      return await db
        .select()
        .from(sequences)
        .where(
          and(
            eq(sequences.teamId, teamId),
            not(eq(sequences.status, 'archived'))
          )
        )
        .orderBy(desc(sequences.updatedAt));
    },

    getById: async (sequenceId: string): Promise<Sequence | null> => {
      const result = await db
        .select()
        .from(sequences)
        .where(and(eq(sequences.id, sequenceId), eq(sequences.teamId, teamId)));
      return result[0] ?? null;
    },

    getWithFrames: async (
      sequenceId: string
    ): Promise<SequenceWithFrames | null> => {
      const result = await db.query.sequences.findFirst({
        where: and(eq(sequences.id, sequenceId), eq(sequences.teamId, teamId)),
        with: {
          frames: {
            orderBy: (frames, { asc }) => [asc(frames.orderIndex)],
          },
          style: true,
        },
      });
      if (!result) return null;
      // Drizzle relational query returns the correct shape but with a wider type
      const { frames: seqFrames, style, ...sequence } = result;
      return {
        ...sequence,
        frames: seqFrames,
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- DB result may be undefined at runtime
        style: style ?? null,
      } as SequenceWithFrames;
    },

    getForUser: async (params: { sequenceId: string }): Promise<Sequence> => {
      const sequence = await db.query.sequences.findFirst({
        where: and(
          eq(sequences.id, params.sequenceId),
          eq(sequences.teamId, teamId)
        ),
      });
      if (!sequence) {
        throw new ValidationError('Sequence not found');
      }
      return sequence;
    },
  };
}

export function createSequencesMethods(
  db: Database,
  teamId: string,
  userId: string
) {
  return {
    ...createSequencesReadMethods(db, teamId),

    create: async (params: {
      title: string;
      script?: string | null;
      styleId: string;
      aspectRatio?: AspectRatio;
      analysisModel: string;
      imageModel?: string;
      videoModel?: string;
      musicModel?: string;
      autoGenerateMotion?: boolean;
      autoGenerateMusic?: boolean;
      suggestedTalentIds?: string[];
      suggestedLocationIds?: string[];
    }): Promise<Sequence> => {
      const sequenceData: NewSequence = {
        teamId,
        createdBy: userId,
        updatedBy: userId,
        title: params.title,
        script: params.script,
        styleId: params.styleId,
        aspectRatio: params.aspectRatio ?? DEFAULT_ASPECT_RATIO,
        analysisModel: params.analysisModel,
        imageModel: params.imageModel,
        videoModel: params.videoModel,
        musicModel: params.musicModel,
        autoGenerateMotion: params.autoGenerateMotion ?? false,
        autoGenerateMusic: params.autoGenerateMusic ?? false,
        suggestedTalentIds: params.suggestedTalentIds ?? null,
        suggestedLocationIds: params.suggestedLocationIds ?? null,
        status: 'draft',
      };

      const [data] = await db
        .insert(sequences)
        .values(sequenceData)
        .returning();

      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
      if (!data) {
        throw new Error('No sequence returned from database');
      }

      return data;
    },

    update: async (params: {
      id: string;
      title?: string;
      script?: string | null;
      styleId?: string;
      status?: SequenceStatus;
      analysisModel?: string;
      aspectRatio?: AspectRatio;
      imageModel?: string;
      videoModel?: string;
      musicStatus?: MusicStatus;
      musicError?: string | null;
      musicUrl?: string;
      musicPath?: string;
      musicGeneratedAt?: Date;
      posterUrl?: string | null;
    }): Promise<Sequence> => {
      const [data] = await db
        .update(sequences)
        .set(params)
        .where(eq(sequences.id, params.id))
        .returning();

      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: DB query may return undefined
      if (!data) {
        throw new ValidationError('Sequence not found');
      }

      return data;
    },

    delete: async (sequenceId: string): Promise<void> => {
      await db.delete(sequences).where(eq(sequences.id, sequenceId));
    },

    updateTitle: async (sequenceId: string, title: string): Promise<void> => {
      await db
        .update(sequences)
        .set({ title, updatedAt: new Date() })
        .where(eq(sequences.id, sequenceId));
    },

    updateAnalysisDurationMs: async (
      sequenceId: string,
      durationMs: number
    ): Promise<void> => {
      await db
        .update(sequences)
        .set({ analysisDurationMs: durationMs, updatedAt: new Date() })
        .where(eq(sequences.id, sequenceId));
    },

    updateMusicPrompt: async (
      sequenceId: string,
      musicPrompt: string,
      musicTags: string
    ): Promise<void> => {
      await db
        .update(sequences)
        .set({ musicPrompt, musicTags, updatedAt: new Date() })
        .where(eq(sequences.id, sequenceId));
    },

    updateWorkflow: async (
      sequenceId: string,
      workflow: string
    ): Promise<void> => {
      await db
        .update(sequences)
        .set({ workflow, updatedAt: new Date() })
        .where(eq(sequences.id, sequenceId));
    },
  };
}

export function createSequenceReadMethods(db: Database, sequenceId: string) {
  return {
    getMusicStatus: async () => {
      const [row] = await db
        .select({
          musicStatus: sequences.musicStatus,
          musicUrl: sequences.musicUrl,
        })
        .from(sequences)
        .where(eq(sequences.id, sequenceId));
      return row;
    },

    getMergedVideoStatus: async () => {
      const [row] = await db
        .select({
          mergedVideoStatus: sequences.mergedVideoStatus,
          mergedVideoUrl: sequences.mergedVideoUrl,
        })
        .from(sequences)
        .where(eq(sequences.id, sequenceId));
      return row;
    },
  };
}

export function createSequenceMethods(db: Database, sequenceId: string) {
  return {
    ...createSequenceReadMethods(db, sequenceId),

    updateStatus: async (status: SequenceStatus, error?: string | null) => {
      await db
        .update(sequences)
        .set({ status, statusError: error ?? null, updatedAt: new Date() })
        .where(eq(sequences.id, sequenceId));
    },

    updateMusicFields: async (fields: MusicFieldsUpdate) => {
      await db
        .update(sequences)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(sequences.id, sequenceId));
    },

    updateMergedVideoFields: async (fields: MergedVideoFieldsUpdate) => {
      await db
        .update(sequences)
        .set({ ...fields, updatedAt: new Date() })
        .where(eq(sequences.id, sequenceId));
    },
  };
}
