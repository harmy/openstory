import { getFrameStalenessFn } from '@/functions/frames';
import { useQuery } from '@tanstack/react-query';

/**
 * Per-artifact staleness state.
 *   - `'stale'`     — stored input hash no longer matches a freshly-computed one.
 *   - `'fresh'`     — stored input hash matches; the artifact is up-to-date.
 *   - `'untracked'` — the artifact has no input hash on file (legacy data, or
 *                     never generated). The UI must not show a regenerate
 *                     prompt — we have no opinion to surface.
 */
type ArtifactStaleness = 'stale' | 'fresh' | 'untracked';

export type FrameStaleness = {
  thumbnail: ArtifactStaleness;
  visualPrompt: ArtifactStaleness;
  motionPrompt: ArtifactStaleness;
};

export const frameStalenessKey = (frameId: string | undefined) =>
  ['frame-staleness', frameId] as const;

/**
 * Shared query for frame staleness — consumers must use this hook rather
 * than an inline `useQuery` so cache invalidation hits one entry.
 */
export function useFrameStaleness(args: {
  sequenceId: string;
  frameId: string | undefined;
}) {
  const { sequenceId, frameId } = args;
  return useQuery<FrameStaleness>({
    queryKey: frameStalenessKey(frameId),
    queryFn: () => {
      if (!frameId) throw new Error('frameId required');
      return getFrameStalenessFn({ data: { sequenceId, frameId } });
    },
    enabled: !!frameId,
    staleTime: 30_000,
  });
}
