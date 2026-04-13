import { useMemo, useState, useEffect } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import {
  getAdminFramesFn,
  getAdminSequencesFn,
  searchUsersFn,
} from '@/functions/admin-support';
import type { SequenceWithFrames } from './use-sequences-with-frames';
import type { Frame, Sequence } from '@/types/database';

export const adminSupportKeys = {
  all: ['admin-support'] as const,
  userSearch: (query: string) =>
    [...adminSupportKeys.all, 'search', query] as const,
  sequences: (teamId: string) =>
    [...adminSupportKeys.all, 'sequences', teamId] as const,
  frames: (sequenceId: string) =>
    [...adminSupportKeys.all, 'frames', sequenceId] as const,
};

export function useAdminUserSearch(query: string) {
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  return useQuery({
    queryKey: adminSupportKeys.userSearch(debouncedQuery),
    queryFn: () => searchUsersFn({ data: { query: debouncedQuery } }),
    enabled: debouncedQuery.length >= 2,
    staleTime: 30_000,
  });
}

export function useAdminSequencesWithFrames(teamId: string | null) {
  const {
    data: sequences,
    isLoading: seqLoading,
    error: seqError,
  } = useQuery({
    queryKey: adminSupportKeys.sequences(teamId ?? ''),
    queryFn: () => getAdminSequencesFn({ data: { teamId: teamId ?? '' } }),
    enabled: !!teamId,
    staleTime: 60_000,
  });

  const framesQueries = useQueries({
    queries: (sequences ?? []).map((seq: Sequence) => ({
      queryKey: adminSupportKeys.frames(seq.id),
      queryFn: async (): Promise<Frame[]> => {
        return getAdminFramesFn({ data: { sequenceId: seq.id } });
      },
      staleTime: 60_000,
      enabled: !!sequences && sequences.length > 0,
    })),
  });

  const data = useMemo<SequenceWithFrames[]>(() => {
    if (!sequences) return [];
    return sequences.map((seq: Sequence, i: number) => ({
      ...seq,
      frames: framesQueries[i]?.data ?? [],
    }));
  }, [sequences, framesQueries]);

  const isLoading =
    seqLoading ||
    (sequences &&
      sequences.length > 0 &&
      framesQueries.some((q) => q.isLoading));

  const error = seqError || framesQueries.find((q) => q.error)?.error;

  return {
    data: isLoading ? undefined : data,
    isLoading,
    error,
  };
}
