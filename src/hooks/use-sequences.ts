import {
  archiveSequenceFn,
  createSequenceFn,
  getSequenceFn,
  getSequencesFn,
  updateSequenceFn,
} from '@/functions/sequences';
import { DEFAULT_ANALYSIS_MODEL } from '@/lib/ai/models.config';
import {
  type CreateSequenceInput,
  type UpdateSequenceInput,
} from '@/lib/schemas/sequence.schemas';
import type { Sequence } from '@/types/database';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// Query keys
export const sequenceKeys = {
  all: ['sequences'] as const,
  lists: () => [...sequenceKeys.all, 'list'] as const,
  list: (teamId?: string) => [...sequenceKeys.lists(), teamId] as const,
  details: () => [...sequenceKeys.all, 'detail'] as const,
  detail: (id?: string) => [...sequenceKeys.details(), id] as const,
};

// Hook for listing sequences
export function useSequences(teamId?: string) {
  return useQuery<Sequence[]>({
    queryKey: sequenceKeys.list(teamId),
    queryFn: async () => {
      return getSequencesFn();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

// Hook for getting single sequence
export function useSequence(
  id?: string,
  options?: {
    refetchInterval?:
      | number
      | false
      | ((query: { state: { data: Sequence | undefined } }) => number | false);
    staleTime?: number;
  }
) {
  return useQuery<Sequence>({
    queryKey: sequenceKeys.detail(id),
    queryFn: async () => {
      if (!id) throw new Error('sequenceId is required');
      return await getSequenceFn({ data: { sequenceId: id } });
    },
    throwOnError: true,
    staleTime: options?.staleTime ?? 1000,
    enabled: !!id,
    refetchInterval: options?.refetchInterval ?? false,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  });
}

// Hook for creating sequence (supports multi-model selection)
export function useCreateSequence() {
  const queryClient = useQueryClient();

  return useMutation<
    { data: Sequence[]; message?: string },
    Error,
    CreateSequenceInput
  >({
    mutationFn: async (input) => {
      const sequences = await createSequenceFn({
        data: {
          script: input.script,
          styleId: input.styleId,
          title: input.title || 'Untitled Sequence',
          // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
          analysisModels: input.analysisModels || [DEFAULT_ANALYSIS_MODEL],
          teamId: input.teamId,
          aspectRatio: input.aspectRatio,
          imageModel: input.imageModel,
          videoModel: input.videoModel,
          autoGenerateMotion: input.autoGenerateMotion,
          autoGenerateMusic: input.autoGenerateMusic,
          musicModel: input.musicModel,
          suggestedTalentIds: input.suggestedTalentIds,
          suggestedLocationIds: input.suggestedLocationIds,
        },
      });

      return {
        data: sequences,
        message: 'Sequence created successfully',
      };
    },
    onSuccess: () => {
      queryClient
        .invalidateQueries({ queryKey: sequenceKeys.lists() })
        .catch((error) => {
          console.error('Error invalidating sequences list on success:', error);
        });
    },
  });
}

// Hook for updating sequence
export function useUpdateSequence() {
  const queryClient = useQueryClient();

  return useMutation<Sequence, Error, UpdateSequenceInput & { id: string }>({
    mutationFn: async (input: UpdateSequenceInput & { id: string }) => {
      const { id, ...updateData } = input;
      return updateSequenceFn({
        data: {
          sequenceId: id,
          ...updateData,
        },
      });
    },
    onSuccess: (data) => {
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (data?.id) {
        queryClient.setQueryData(sequenceKeys.detail(data.id), data);
      }
      queryClient
        .invalidateQueries({ queryKey: sequenceKeys.lists() })
        .catch((error) => {
          console.error('Error invalidating sequences list on success:', error);
        });
    },
  });
}

// Hook for archiving sequence
export function useArchiveSequence() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: async (id: string) => {
      await archiveSequenceFn({ data: { sequenceId: id } });
    },
    onSuccess: (_, id) => {
      queryClient.removeQueries({ queryKey: sequenceKeys.detail(id) });
      void queryClient.invalidateQueries({ queryKey: sequenceKeys.lists() });
    },
  });
}
