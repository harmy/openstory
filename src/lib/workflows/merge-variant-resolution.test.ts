/**
 * Behavioural tests for the merge-* variant resolution helpers.
 *
 * These pin the data-corruption-vs-legitimate-skip decision tree that gates
 * the audio mux and the audio-video step. The earlier inline implementation
 * silently returned `null` for several distinct failure conditions; this
 * version distinguishes "no music produced" from "data inconsistency" and
 * throws on the latter.
 */

import { describe, expect, it } from 'bun:test';
import type {
  SequenceMusicVariant,
  SequenceVideoVariant,
} from '@/lib/db/schema';
import {
  resolveMergeAudioVideoSourceUrls,
  resolveMotionBatchMergeMusicVariants,
  resolveMusicVariantForMux,
  type MergeVariantResolutionScopedDb,
} from './merge-variant-resolution';

const SEQ_ID = 'seq_01';
const VIDEO_VARIANT_ID = 'svv_01';
const MUSIC_VARIANT_ID = 'smv_01';
const MERGE_WORKFLOW = 'merge-video';

type MusicStatus = Awaited<
  ReturnType<
    ReturnType<MergeVariantResolutionScopedDb['sequence']>['getMusicStatus']
  >
>;

function buildScopedDb(opts: {
  musicStatus?: MusicStatus;
  musicPrimary?: SequenceMusicVariant | null;
  videoPrimary?: SequenceVideoVariant | null;
  videoById?: SequenceVideoVariant | null;
  musicById?: SequenceMusicVariant | null;
}): MergeVariantResolutionScopedDb {
  return {
    sequence: () => ({
      getMusicStatus: async () => opts.musicStatus,
    }),
    sequenceVariants: {
      getMusicPrimary: async () => opts.musicPrimary ?? null,
      getVideoPrimary: async () => opts.videoPrimary ?? null,
      getVideoById: async () => opts.videoById ?? null,
      getMusicById: async () => opts.musicById ?? null,
    },
  };
}

const musicVariant = (
  overrides: Partial<SequenceMusicVariant> = {}
): SequenceMusicVariant => ({
  id: MUSIC_VARIANT_ID,
  sequenceId: SEQ_ID,
  url: 'https://r2/music.mp3',
  storagePath: 'teams/t/seq/music.mp3',
  prompt: 'p',
  tags: 'jazz',
  durationSeconds: 60,
  model: 'fal/cassette',
  status: 'completed',
  workflowRunId: null,
  generatedAt: new Date(),
  error: null,
  inputHash: 'hash-1',
  divergedAt: null,
  discardedAt: null,
  loudnessGainDb: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const videoVariant = (
  overrides: Partial<SequenceVideoVariant> = {}
): SequenceVideoVariant => ({
  id: VIDEO_VARIANT_ID,
  sequenceId: SEQ_ID,
  url: 'https://r2/merged.mp4',
  storagePath: 'teams/t/seq/merged.mp4',
  workflow: MERGE_WORKFLOW,
  status: 'completed',
  workflowRunId: null,
  generatedAt: new Date(),
  error: null,
  inputHash: 'video-hash-1',
  divergedAt: null,
  discardedAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('resolveMusicVariantForMux', () => {
  it('returns null when sequence has no completed music (legitimate skip)', async () => {
    const result = await resolveMusicVariantForMux(
      buildScopedDb({
        musicStatus: {
          musicStatus: 'generating',
          musicUrl: null,
          musicModel: null,
        },
      }),
      SEQ_ID
    );
    expect(result).toBeNull();
  });

  it('returns null when getMusicStatus returns undefined (no music ever requested)', async () => {
    const result = await resolveMusicVariantForMux(
      buildScopedDb({ musicStatus: undefined }),
      SEQ_ID
    );
    expect(result).toBeNull();
  });

  it('throws when status=completed but musicUrl is missing (sequences row inconsistent)', () => {
    return expect(
      resolveMusicVariantForMux(
        buildScopedDb({
          musicStatus: {
            musicStatus: 'completed',
            musicUrl: null,
            musicModel: 'fal/cassette',
          },
        }),
        SEQ_ID
      )
    ).rejects.toThrow(/musicUrl.*missing/);
  });

  it('throws when status=completed but musicModel is missing', () => {
    return expect(
      resolveMusicVariantForMux(
        buildScopedDb({
          musicStatus: {
            musicStatus: 'completed',
            musicUrl: 'https://r2/music.mp3',
            musicModel: null,
          },
        }),
        SEQ_ID
      )
    ).rejects.toThrow(/musicUrl.*musicModel.*missing/);
  });

  it('throws when sequences.musicStatus is completed but no matching variant row exists', () => {
    return expect(
      resolveMusicVariantForMux(
        buildScopedDb({
          musicStatus: {
            musicStatus: 'completed',
            musicUrl: 'https://r2/music.mp3',
            musicModel: 'fal/cassette',
          },
          musicPrimary: null,
        }),
        SEQ_ID
      )
    ).rejects.toThrow(/no matching sequence_music_variants primary row exists/);
  });

  it('throws when the primary music variant has incomplete status', () => {
    return expect(
      resolveMusicVariantForMux(
        buildScopedDb({
          musicStatus: {
            musicStatus: 'completed',
            musicUrl: 'https://r2/music.mp3',
            musicModel: 'fal/cassette',
          },
          musicPrimary: musicVariant({ status: 'pending' }),
        }),
        SEQ_ID
      )
    ).rejects.toThrow(/refusing to mux/);
  });

  it('throws when the primary music variant has no url', () => {
    return expect(
      resolveMusicVariantForMux(
        buildScopedDb({
          musicStatus: {
            musicStatus: 'completed',
            musicUrl: 'https://r2/music.mp3',
            musicModel: 'fal/cassette',
          },
          musicPrimary: musicVariant({ url: null }),
        }),
        SEQ_ID
      )
    ).rejects.toThrow(/refusing to mux/);
  });

  it('returns the primary variant id when all checks pass', async () => {
    const result = await resolveMusicVariantForMux(
      buildScopedDb({
        musicStatus: {
          musicStatus: 'completed',
          musicUrl: 'https://r2/music.mp3',
          musicModel: 'fal/cassette',
        },
        musicPrimary: musicVariant(),
      }),
      SEQ_ID
    );
    expect(result).toBe(MUSIC_VARIANT_ID);
  });
});

describe('resolveMergeAudioVideoSourceUrls', () => {
  it('throws WorkflowValidationError when video variant is missing', () => {
    return expect(
      resolveMergeAudioVideoSourceUrls(
        buildScopedDb({
          videoById: null,
          musicById: musicVariant(),
        }),
        VIDEO_VARIANT_ID,
        MUSIC_VARIANT_ID
      )
    ).rejects.toThrow(/Merged video variant.*not found or missing url/);
  });

  it('throws when video variant exists but url is null', () => {
    return expect(
      resolveMergeAudioVideoSourceUrls(
        buildScopedDb({
          videoById: videoVariant({ url: null }),
          musicById: musicVariant(),
        }),
        VIDEO_VARIANT_ID,
        MUSIC_VARIANT_ID
      )
    ).rejects.toThrow(/Merged video variant.*not found or missing url/);
  });

  it('throws when music variant is missing', () => {
    return expect(
      resolveMergeAudioVideoSourceUrls(
        buildScopedDb({
          videoById: videoVariant(),
          musicById: null,
        }),
        VIDEO_VARIANT_ID,
        MUSIC_VARIANT_ID
      )
    ).rejects.toThrow(/Music variant.*not found or missing url/);
  });

  it('throws when music variant exists but url is null', () => {
    return expect(
      resolveMergeAudioVideoSourceUrls(
        buildScopedDb({
          videoById: videoVariant(),
          musicById: musicVariant({ url: null }),
        }),
        VIDEO_VARIANT_ID,
        MUSIC_VARIANT_ID
      )
    ).rejects.toThrow(/Music variant.*not found or missing url/);
  });

  it('returns both source URLs when both variants resolve cleanly', async () => {
    const result = await resolveMergeAudioVideoSourceUrls(
      buildScopedDb({
        videoById: videoVariant(),
        musicById: musicVariant(),
      }),
      VIDEO_VARIANT_ID,
      MUSIC_VARIANT_ID
    );
    expect(result).toEqual({
      mergedVideoUrl: 'https://r2/merged.mp4',
      musicUrl: 'https://r2/music.mp3',
    });
  });
});

describe('resolveMotionBatchMergeMusicVariants', () => {
  it('throws when sequences.musicModel is missing', () => {
    return expect(
      resolveMotionBatchMergeMusicVariants(
        buildScopedDb({
          musicStatus: {
            musicStatus: 'completed',
            musicUrl: 'https://r2/m.mp3',
            musicModel: null,
          },
        }),
        SEQ_ID,
        MERGE_WORKFLOW
      )
    ).rejects.toThrow(/no model recorded/);
  });

  it('throws when video primary is missing', () => {
    return expect(
      resolveMotionBatchMergeMusicVariants(
        buildScopedDb({
          musicStatus: {
            musicStatus: 'completed',
            musicUrl: 'https://r2/m.mp3',
            musicModel: 'fal/cassette',
          },
          videoPrimary: null,
          musicPrimary: musicVariant(),
        }),
        SEQ_ID,
        MERGE_WORKFLOW
      )
    ).rejects.toThrow(/Merged video primary variant not found/);
  });

  it('throws when video primary is not completed', () => {
    return expect(
      resolveMotionBatchMergeMusicVariants(
        buildScopedDb({
          musicStatus: {
            musicStatus: 'completed',
            musicUrl: 'https://r2/m.mp3',
            musicModel: 'fal/cassette',
          },
          videoPrimary: videoVariant({ status: 'pending' }),
          musicPrimary: musicVariant(),
        }),
        SEQ_ID,
        MERGE_WORKFLOW
      )
    ).rejects.toThrow(/Merged video primary variant not found/);
  });

  it('throws when music primary is missing', () => {
    return expect(
      resolveMotionBatchMergeMusicVariants(
        buildScopedDb({
          musicStatus: {
            musicStatus: 'completed',
            musicUrl: 'https://r2/m.mp3',
            musicModel: 'fal/cassette',
          },
          videoPrimary: videoVariant(),
          musicPrimary: null,
        }),
        SEQ_ID,
        MERGE_WORKFLOW
      )
    ).rejects.toThrow(/Music primary variant not found/);
  });

  it('returns both variant ids when both primaries are completed', async () => {
    const result = await resolveMotionBatchMergeMusicVariants(
      buildScopedDb({
        musicStatus: {
          musicStatus: 'completed',
          musicUrl: 'https://r2/m.mp3',
          musicModel: 'fal/cassette',
        },
        videoPrimary: videoVariant(),
        musicPrimary: musicVariant(),
      }),
      SEQ_ID,
      MERGE_WORKFLOW
    );
    expect(result).toEqual({
      mergedVideoVariantId: VIDEO_VARIANT_ID,
      musicVariantId: MUSIC_VARIANT_ID,
    });
  });
});
