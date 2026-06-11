/**
 * Hook for fetching sequence characters
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getFrameIdsForCharacterFn,
  getSequenceCharactersFn,
  recastCharacterFn,
} from '@/functions/sequence-characters';
import { addCharacterToLibraryFn } from '@/functions/talent';
import type { CharacterWithTalent } from '@/lib/db/schema';

export const sequenceCharacterKeys = {
  all: ['sequence-characters'] as const,
  list: (sequenceId: string) =>
    [...sequenceCharacterKeys.all, 'list', sequenceId] as const,
  framesForCharacter: (sequenceId: string, characterId: string) =>
    [...sequenceCharacterKeys.all, 'frames', sequenceId, characterId] as const,
};

export function useSequenceCharacters(sequenceId: string) {
  return useQuery<CharacterWithTalent[]>({
    queryKey: sequenceCharacterKeys.list(sequenceId),
    queryFn: async () => {
      return getSequenceCharactersFn({ data: { sequenceId } });
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - characters don't change often
    enabled: !!sequenceId,
  });
}

/**
 * Hook for adding a sequence character to the team's talent library
 */
export function useAddCharacterToLibrary() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (characterId: string) =>
      addCharacterToLibraryFn({ data: { characterId } }),
    onSuccess: () => {
      // Invalidate talent queries to refresh library
      void queryClient.invalidateQueries({ queryKey: ['talent'] });
    },
  });
}

/**
 * Hook to get the count of frames containing a character
 * Used to show affected frames before recasting
 */
export function useFrameIdsForCharacter(
  sequenceId: string,
  characterId: string
) {
  return useQuery({
    queryKey: sequenceCharacterKeys.framesForCharacter(sequenceId, characterId),
    queryFn: () =>
      getFrameIdsForCharacterFn({ data: { sequenceId, characterId } }),
    enabled: !!sequenceId && !!characterId,
    staleTime: 60 * 1000, // 1 minute
  });
}

/**
 * Hook for recasting a character with a talent from the library
 */
export function useRecastCharacter() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { characterId: string; talentId: string }) =>
      recastCharacterFn({ data }),
    onSuccess: () => {
      // Invalidate sequence characters to refresh the list
      void queryClient.invalidateQueries({
        queryKey: sequenceCharacterKeys.all,
      });
      // Invalidate frames that contain this character
      void queryClient.invalidateQueries({ queryKey: ['frames'] });
    },
  });
}
