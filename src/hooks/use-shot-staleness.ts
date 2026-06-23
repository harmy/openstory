import { getShotStalenessFn } from '@/functions/shots';
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

export type ShotStaleness = {
  thumbnail: ArtifactStaleness;
  visualPrompt: ArtifactStaleness;
  motionPrompt: ArtifactStaleness;
};

export const shotStalenessKey = (shotId: string | undefined) =>
  ['shot-staleness', shotId] as const;

/**
 * Shared query for shot staleness — consumers must use this hook rather
 * than an inline `useQuery` so cache invalidation hits one entry.
 */
export function useShotStaleness(args: {
  sequenceId: string;
  shotId: string | undefined;
}) {
  const { sequenceId, shotId } = args;
  return useQuery<ShotStaleness>({
    queryKey: shotStalenessKey(shotId),
    queryFn: () => {
      if (!shotId) throw new Error('shotId required');
      return getShotStalenessFn({ data: { sequenceId, shotId } });
    },
    enabled: !!shotId,
    staleTime: 30_000,
  });
}
