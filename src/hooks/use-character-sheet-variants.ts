import {
  discardCharacterSheetVariantFn,
  getSequenceCharacterDivergentVariantsFn,
  promoteCharacterSheetVariantFn,
  undiscardCharacterSheetVariantFn,
} from '@/functions/character-sheet-variants';
import { sequenceCharacterKeys } from '@/hooks/use-sequence-characters';
import type { CharacterSheetVariant } from '@/lib/db/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const characterSheetVariantKeys = {
  all: ['character-sheet-variants'] as const,
  divergentBySequence: (sequenceId: string) =>
    [...characterSheetVariantKeys.all, 'sequence', sequenceId] as const,
};

/**
 * Query the active divergent character-sheet alternates for every character
 * in a sequence. Drives the corner-dot indicator on talent cards and the
 * banner on the character detail view. Mirrors `useDivergentVariants`.
 */
export function useCharacterDivergentVariants(
  sequenceId: string | undefined,
  options?: { refetchInterval?: number | false }
) {
  return useQuery<CharacterSheetVariant[]>({
    queryKey: characterSheetVariantKeys.divergentBySequence(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getSequenceCharacterDivergentVariantsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

type VariantInput = { sequenceId: string; variantId: string };

export function usePromoteCharacterSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: VariantInput) =>
      promoteCharacterSheetVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: characterSheetVariantKeys.divergentBySequence(sequenceId),
        }),
        // The promoted url overwrites characters.sheetImageUrl — invalidate
        // the upstream characters list so the live image swaps in the UI.
        queryClient.invalidateQueries({
          queryKey: sequenceCharacterKeys.list(sequenceId),
        }),
      ]);
    },
  });
}

export function useDiscardCharacterSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { variantId: string; discardedAt: Date },
    Error,
    VariantInput
  >({
    mutationFn: async (input) =>
      discardCharacterSheetVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: characterSheetVariantKeys.divergentBySequence(sequenceId),
      });
    },
  });
}

export function useUndiscardCharacterSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation<{ variantId: string }, Error, VariantInput>({
    mutationFn: async (input) =>
      undiscardCharacterSheetVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: characterSheetVariantKeys.divergentBySequence(sequenceId),
      });
    },
  });
}
