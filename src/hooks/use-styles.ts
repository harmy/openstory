import { getPublicStylesFn, getStyleFn, getStylesFn } from '@/functions/styles';
import { usePublicOrTeamQuery } from '@/hooks/use-public-or-team-query';
import type { Style } from '@/types/database';
import { useQuery } from '@tanstack/react-query';

// Query keys
export const styleKeys = {
  all: ['styles'] as const,
  lists: () => [...styleKeys.all, 'list'] as const,
  list: (teamId?: string) => [...styleKeys.lists(), teamId] as const,
  public: () => [...styleKeys.lists(), 'public'] as const,
  details: () => [...styleKeys.all, 'detail'] as const,
  detail: (id: string) => [...styleKeys.details(), id] as const,
};

// Hook for listing styles.
// Anonymous (logged-out) visitors get the public style catalogue so they can
// compose a sequence before signing in; authenticated users get their team's
// styles plus public ones (see usePublicOrTeamQuery for the session rules).
export function useStyles(teamId?: string, enabled = true) {
  return usePublicOrTeamQuery<Style[]>({
    teamKey: styleKeys.list(teamId),
    publicKey: styleKeys.public(),
    teamFn: () => getStylesFn(),
    publicFn: () => getPublicStylesFn(),
    staleTime: 10 * 60 * 1000, // 10 minutes (styles change less frequently)
    enabled,
  });
}

// Hook for getting single style
export function useStyle(id: string) {
  return useQuery<Style>({
    queryKey: styleKeys.detail(id),
    queryFn: async () => {
      return getStyleFn({ data: { styleId: id } });
    },
    staleTime: 10 * 60 * 1000,
    enabled: !!id,
  });
}
