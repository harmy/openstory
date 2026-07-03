import {
  getComposedScriptFn,
  getScenesFn,
  updateSceneModelFn,
  type SceneModelInput,
} from '@/functions/scenes';
import type { SceneRow } from '@/lib/db/schema';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { shotKeys } from './use-shots';

export const sceneKeys = {
  all: ['scenes'] as const,
  list: (sequenceId: string) => [...sceneKeys.all, 'list', sequenceId] as const,
  composedScript: (sequenceId: string) =>
    [...sceneKeys.all, 'composed-script', sequenceId] as const,
};

/** Composed sequence script from selected scene versions (#1030). */
export function useComposedScript(sequenceId?: string) {
  return useQuery({
    queryKey: sceneKeys.composedScript(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getComposedScriptFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

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

// The mutation input is exactly the server fn's validated input — derive it so
// the ULID + branded-model-id typing flows to the client call sites (#909).
type UpdateSceneModelInput = SceneModelInput;

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
    onError: (error, input, ctx) => {
      if (ctx?.previous) {
        queryClient.setQueryData(
          sceneKeys.list(input.sequenceId),
          ctx.previous
        );
      }
      // The optimistic patch silently reverts on failure — surface it so the
      // user knows the selector snapping back means the write didn't land.
      toast.error('Failed to update scene model', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
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
