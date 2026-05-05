import {
  discardSequenceLocationSheetVariantFn,
  getSequenceLocationDivergentVariantsFn,
  promoteSequenceLocationSheetVariantFn,
  undiscardSequenceLocationSheetVariantFn,
} from '@/functions/location-sheet-variants';
import {
  libraryLocationKeys,
  sequenceLocationKeys,
} from '@/hooks/use-sequence-locations';
import type { LocationSheetVariant } from '@/lib/db/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const locationSheetVariantKeys = {
  all: ['location-sheet-variants'] as const,
  divergentBySequence: (sequenceId: string) =>
    [...locationSheetVariantKeys.all, 'sequence', sequenceId] as const,
};

/**
 * Active divergent variants for the sequence locations in a sequence. Drives
 * the corner-dot indicator on `location-card` and the banner on the location
 * detail view.
 */
export function useSequenceLocationDivergentVariants(
  sequenceId: string | undefined,
  options?: { refetchInterval?: number | false }
) {
  return useQuery<LocationSheetVariant[]>({
    queryKey: locationSheetVariantKeys.divergentBySequence(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getSequenceLocationDivergentVariantsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

type VariantInput = { sequenceId: string; variantId: string };

export function usePromoteSequenceLocationSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: VariantInput) =>
      promoteSequenceLocationSheetVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: locationSheetVariantKeys.divergentBySequence(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: sequenceLocationKeys.list(sequenceId),
        }),
        // Library team locations may also change because the recast wizard
        // surfaces the underlying library row.
        queryClient.invalidateQueries({
          queryKey: libraryLocationKeys.all,
        }),
      ]);
    },
  });
}

export function useDiscardSequenceLocationSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { variantId: string; discardedAt: Date },
    Error,
    VariantInput
  >({
    mutationFn: async (input) =>
      discardSequenceLocationSheetVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: locationSheetVariantKeys.divergentBySequence(sequenceId),
      });
    },
  });
}

export function useUndiscardSequenceLocationSheetVariant() {
  const queryClient = useQueryClient();
  return useMutation<{ variantId: string }, Error, VariantInput>({
    mutationFn: async (input) =>
      undiscardSequenceLocationSheetVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: locationSheetVariantKeys.divergentBySequence(sequenceId),
      });
    },
  });
}
