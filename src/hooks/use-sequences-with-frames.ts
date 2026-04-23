import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { useSequences } from './use-sequences';
import { frameKeys } from './use-frames';
import { getFramesFn } from '@/functions/frames';
import type { Sequence, Frame } from '@/types/database';

export type SequenceWithFrames = Sequence & { frames: Frame[] };

/**
 * Fetches all sequences and their frames in parallel.
 * Returns sequences as soon as they resolve so the UI can render rows
 * progressively; frames are reported via `framesLoadingMap` per sequence.
 */
export function useSequencesWithFrames() {
  const {
    data: sequences,
    isLoading: seqLoading,
    error: seqError,
  } = useSequences();

  const framesQueries = useQueries({
    queries: (sequences || []).map((seq: Sequence) => ({
      queryKey: frameKeys.list(seq.id),
      queryFn: async (): Promise<Frame[]> => {
        const data = await getFramesFn({ data: { sequenceId: seq.id } });
        return data;
      },
      staleTime: 5 * 60 * 1000,
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

  const framesLoadingMap = useMemo<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    (sequences ?? []).forEach((seq, i) => {
      const q = framesQueries[i];
      map[seq.id] = Boolean(q?.isLoading);
    });
    return map;
  }, [sequences, framesQueries]);

  const error = seqError || framesQueries.find((q) => q.error)?.error;

  return {
    data,
    isLoading: seqLoading,
    framesLoadingMap,
    error,
  };
}
