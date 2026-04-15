import {
  createStyleFn,
  deleteStyleFn,
  getStyleFn,
  getStylesFn,
  updateStyleFn,
} from '@/functions/styles';
import type { StyleConfig } from '@/lib/db/schema/libraries';
import type { Style } from '@/types/database';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

// Local hook input types (simpler than server schema types)
type CreateStyleInput = {
  teamId: string;
  name: string;
  description?: string;
  config: StyleConfig;
  category?: string;
  tags?: string[];
  isPublic?: boolean;
  previewUrl?: string | null;
};

// Query keys
const styleKeys = {
  all: ['styles'] as const,
  lists: () => [...styleKeys.all, 'list'] as const,
  list: (teamId?: string) => [...styleKeys.lists(), teamId] as const,
  details: () => [...styleKeys.all, 'detail'] as const,
  detail: (id: string) => [...styleKeys.details(), id] as const,
};

// Hook for listing styles
export function useStyles(teamId?: string, enabled = true) {
  return useQuery<Style[]>({
    queryKey: styleKeys.list(teamId),
    queryFn: async () => {
      return getStylesFn();
    },
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

// Hook for creating style
export function useCreateStyle() {
  const queryClient = useQueryClient();

  return useMutation<Style, Error, CreateStyleInput>({
    mutationFn: async (input: CreateStyleInput) => {
      const data = await createStyleFn({
        data: input satisfies Parameters<typeof createStyleFn>[0]['data'],
      });
      return data;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: styleKeys.lists() });
    },
  });
}

// Hook for updating style
export function useUpdateStyle() {
  const queryClient = useQueryClient();

  return useMutation<
    Style,
    Error,
    {
      id: string;
      input: Partial<CreateStyleInput>;
    }
  >({
    mutationFn: async ({
      id,
      input,
    }: {
      id: string;
      input: Partial<CreateStyleInput>;
    }) => {
      const data = await updateStyleFn({
        data: {
          styleId: id,
          ...input,
        } satisfies Parameters<typeof updateStyleFn>[0]['data'],
      });
      return data;
    },
    onSuccess: async (data) => {
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (data?.id) {
        queryClient.setQueryData(styleKeys.detail(data.id), data);
      }
      await queryClient.invalidateQueries({ queryKey: styleKeys.lists() });
    },
  });
}

// Hook for deleting style
export function useDeleteStyle() {
  const queryClient = useQueryClient();

  return useMutation<void, Error, string>({
    mutationFn: async (id: string) => {
      await deleteStyleFn({ data: { styleId: id } });
    },
    onSuccess: async (_, id) => {
      queryClient.removeQueries({ queryKey: styleKeys.detail(id) });
      await queryClient.invalidateQueries({ queryKey: styleKeys.lists() });
    },
  });
}
