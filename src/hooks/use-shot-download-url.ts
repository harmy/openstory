import { getShotDownloadUrlFn } from '@/functions/shots';
import { useQuery } from '@tanstack/react-query';

type UseShotDownloadUrlParams = {
  shotId?: string;
  sequenceId?: string;
};

/**
 * Hook to get a signed download URL for a shot's video.
 * Uses Content-Disposition header to force browser download.
 *
 * @param params - Shot and sequence IDs
 * @param enabled - Whether to fetch (default: true)
 * @returns Query result with downloadUrl and filename
 */
export function useShotDownloadUrl(
  { shotId, sequenceId }: UseShotDownloadUrlParams,
  enabled = true
) {
  return useQuery({
    queryKey: ['shot-download-url', shotId, sequenceId],
    queryFn: async () => {
      if (!shotId || !sequenceId) {
        throw new Error('Shot ID and Sequence ID are required');
      }
      return getShotDownloadUrlFn({ data: { shotId, sequenceId } });
    },
    enabled: enabled && !!shotId && !!sequenceId,
    staleTime: 30 * 60 * 1000, // 30 minutes (URLs expire in 1 hour)
  });
}
