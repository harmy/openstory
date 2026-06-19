import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSequences } from './use-sequences';
import { getFramesForSequencesFn } from '@/functions/frames';
import type { Sequence, Frame } from '@/types/database';

export type SequenceWithFrames = Sequence & {
  frames: Frame[];
  // Present only when fetched via the admin/support endpoint. Optional on the
  // base type so components render a single CreatorIdentity regardless of source.
  creatorName?: string | null;
  creatorEmail?: string | null;
};

/**
 * Fetches all sequences and their frames. Previously this fanned out one
 * `getFramesFn` per sequence via `useQueries`, which crashed iOS Chrome's
 * WebProcess once teams accumulated ~50+ sequences (the parallel server-fn
 * round-trips saturated the connection pool — see the
 * `claude/mobile-sequence-navigation-dmLJn` branch history for the wrangler
 * tail). Now one batched call returns every frame, grouped client-side.
 */
export function useSequencesWithFrames() {
  const {
    data: sequences,
    isLoading: seqLoading,
    error: seqError,
  } = useSequences();

  const sequenceIds = useMemo(
    () => (sequences ?? []).map((s) => s.id),
    [sequences]
  );

  const {
    data: framesBySequenceId,
    isLoading: framesLoading,
    error: framesError,
  } = useQuery({
    queryKey: ['frames', 'by-sequences', [...sequenceIds].sort()],
    queryFn: async (): Promise<Map<string, Frame[]>> => {
      if (sequenceIds.length === 0) return new Map();
      const allFrames = await getFramesForSequencesFn({
        data: { sequenceIds },
      });
      const map = new Map<string, Frame[]>();
      for (const frame of allFrames) {
        const existing = map.get(frame.sequenceId) ?? [];
        existing.push(frame);
        map.set(frame.sequenceId, existing);
      }
      return map;
    },
    enabled: sequenceIds.length > 0,
    staleTime: 5 * 60 * 1000,
  });

  const data = useMemo<SequenceWithFrames[]>(() => {
    if (!sequences) return [];
    return sequences.map((seq) => ({
      ...seq,
      frames: framesBySequenceId?.get(seq.id) ?? [],
    }));
  }, [sequences, framesBySequenceId]);

  // Single batch query means a single in-flight signal — every row reflects
  // it identically. Kept as a per-id map so callers (EvalSequencesMobile,
  // EvalMatrix) can render row-level skeletons without a behavior change.
  const framesLoadingMap = useMemo<Record<string, boolean>>(() => {
    const map: Record<string, boolean> = {};
    for (const seq of sequences ?? []) {
      map[seq.id] = framesLoading;
    }
    return map;
  }, [sequences, framesLoading]);

  const error = seqError || framesError;

  return {
    data,
    isLoading: seqLoading,
    framesLoadingMap,
    error,
  };
}
