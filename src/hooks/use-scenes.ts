import { getScenesFn, updateSceneModelFn } from '@/functions/scenes';
import type { SceneRow } from '@/lib/db/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { shotKeys } from './use-shots';

const sceneKeys = {
  all: ['scenes'] as const,
  list: (sequenceId: string) => [...sceneKeys.all, 'list', sequenceId] as const,
};

/** Ordered scenes for a sequence — the editor groups shots under these (#909). */
export function useScenesBySequence(sequenceId?: string) {
  return useQuery<SceneRow[]>({
    queryKey: sceneKeys.list(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getScenesFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

type UpdateSceneModelInput = {
  sequenceId: string;
  sceneId: string;
  imageModel?: string | null;
  videoModel?: string | null;
};

/**
 * Set (or clear) a scene's image/video model override. Optimistically patches
 * the scenes list so the Look/Motion selectors reflect the choice immediately.
 */
export function useUpdateSceneModel() {
  const queryClient = useQueryClient();
  return useMutation<
    SceneRow | undefined,
    Error,
    UpdateSceneModelInput,
    { previous?: SceneRow[] }
  >({
    mutationFn: async (input) => updateSceneModelFn({ data: input }),
    onMutate: async (input) => {
      const key = sceneKeys.list(input.sequenceId);
      await queryClient.cancelQueries({ queryKey: key });
      const previous = queryClient.getQueryData<SceneRow[]>(key);
      if (previous) {
        queryClient.setQueryData<SceneRow[]>(
          key,
          previous.map((scene) =>
            scene.id === input.sceneId
              ? {
                  ...scene,
                  ...('imageModel' in input
                    ? { imageModel: input.imageModel ?? null }
                    : {}),
                  ...('videoModel' in input
                    ? { videoModel: input.videoModel ?? null }
                    : {}),
                }
              : scene
          )
        );
      }
      return { previous };
    },
    onError: (_error, input, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(
          sceneKeys.list(input.sequenceId),
          ctx.previous
        );
      }
    },
    onSettled: async (_data, _error, input) => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sceneKeys.list(input.sequenceId),
        }),
        // Coverage markers read off shots/variants — keep them in sync.
        queryClient.invalidateQueries({
          queryKey: shotKeys.list(input.sequenceId),
        }),
      ]);
    },
  });
}
