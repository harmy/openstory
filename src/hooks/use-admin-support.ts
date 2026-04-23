import { useMemo } from 'react';
import { useInfiniteQuery, useQueries } from '@tanstack/react-query';
import {
  getAdminFramesFn,
  getAllAdminSequencesFn,
} from '@/functions/admin-support';
import type { SequenceWithFrames } from './use-sequences-with-frames';
import type { Frame, Sequence } from '@/types/database';

const PAGE_SIZE = 50;

export const adminSupportKeys = {
  all: ['admin-support'] as const,
  sequences: (search?: string) =>
    [...adminSupportKeys.all, 'sequences', search ?? ''] as const,
  frames: (sequenceId: string) =>
    [...adminSupportKeys.all, 'frames', sequenceId] as const,
};

export type AdminSequenceWithFrames = SequenceWithFrames & {
  creatorName: string | null;
  creatorEmail: string | null;
};

export function useAdminAllSequencesWithFrames(
  enabled: boolean,
  search?: string
) {
  const trimmedSearch = search?.trim() || undefined;

  const {
    data: infiniteData,
    isLoading: seqLoading,
    error: seqError,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useInfiniteQuery({
    queryKey: adminSupportKeys.sequences(trimmedSearch),
    queryFn: ({ pageParam }) =>
      getAllAdminSequencesFn({
        data: {
          limit: PAGE_SIZE,
          offset: pageParam * PAGE_SIZE,
          search: trimmedSearch,
        },
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, _allPages, lastPageParam) =>
      lastPage.length === PAGE_SIZE ? lastPageParam + 1 : undefined,
    enabled,
    staleTime: 60_000,
  });

  const allSequences = useMemo(
    () => infiniteData?.pages.flat() ?? [],
    [infiniteData]
  );

  const framesQueries = useQueries({
    queries: allSequences.map((seq: Sequence) => ({
      queryKey: adminSupportKeys.frames(seq.id),
      queryFn: async (): Promise<Frame[]> => {
        return getAdminFramesFn({ data: { sequenceId: seq.id } });
      },
      staleTime: 60_000,
      enabled: allSequences.length > 0,
    })),
  });

  const data = useMemo<AdminSequenceWithFrames[]>(() => {
    if (allSequences.length === 0) return [];
    return allSequences.map(
      (
        seq: Sequence & {
          creatorName: string | null;
          creatorEmail: string | null;
        },
        i: number
      ) => ({
        ...seq,
        frames: framesQueries[i]?.data ?? [],
      })
    );
  }, [allSequences, framesQueries]);

  const framesLoadingMap = useMemo<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    allSequences.forEach((seq, i) => {
      const q = framesQueries[i];
      map[seq.id] = Boolean(q?.isLoading);
    });
    return map;
  }, [allSequences, framesQueries]);

  const error = seqError || framesQueries.find((q) => q.error)?.error;

  return {
    data,
    isLoading: seqLoading,
    framesLoadingMap,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  };
}
