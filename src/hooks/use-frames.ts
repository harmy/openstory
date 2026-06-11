import type { Frame } from '@/types/database';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { FrameVariant } from '@/lib/db/schema';
import {
  getFramesFn,
  getDivergentVariantsFn,
  promoteVariantFn,
  discardVariantFn,
  undiscardVariantFn,
  getSequenceImageModelsFn,
  getSequenceImageVariantsFn,
  getSequenceVideoModelsFn,
  getSequenceVideoVariantsFn,
} from '@/functions/frames';
import {
  generateFrameVariantsFn,
  selectFrameVariantFn,
  setImageFromVariantFn,
  setVideoFromVariantFn,
} from '@/functions/frame-image';
import type { GenerateVariantInput as SchemaGenerateVariantInput } from '@/lib/schemas/frame.schemas';

type GenerateVariantInput = SchemaGenerateVariantInput & {
  sequenceId: string;
  frameId: string;
};

type SelectVariantInput = {
  sequenceId: string;
  frameId: string;
  variantIndex: number;
};

// Query keys
export const frameKeys = {
  all: ['frames'] as const,
  lists: () => [...frameKeys.all, 'list'] as const,
  list: (sequenceId: string) => [...frameKeys.lists(), sequenceId] as const,
  details: () => [...frameKeys.all, 'detail'] as const,
  detail: (id: string) => [...frameKeys.details(), id] as const,
  divergentVariants: (sequenceId: string) =>
    [...frameKeys.all, 'divergent-variants', sequenceId] as const,
};

// Distinct image models that have generated a variant for this sequence.
// Drives the header image-model dropdown (#547). Flat key matches the
// image:progress cache invalidation in query-cache-updater.
export function useSequenceImageModels(sequenceId?: string) {
  return useQuery<string[]>({
    queryKey: ['sequence-image-models', sequenceId ?? ''],
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getSequenceImageModelsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

// Distinct video models that have generated a variant for this sequence (#545).
// Drives the header video-model dropdown. The realtime video:progress handler
// invalidates `['sequence-video-models', sequenceId]`, matching this key's tail.
export function useSequenceVideoModels(sequenceId?: string) {
  return useQuery<string[]>({
    queryKey: ['sequence-video-models', sequenceId ?? ''],
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getSequenceVideoModelsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

// All video FrameVariant rows for a sequence (#545). Used by the scenes view to
// resolve each frame's displayed video through the active model's variant.
export function useSequenceVideoVariants(sequenceId?: string) {
  return useQuery<FrameVariant[]>({
    queryKey: ['sequence-video-variants', sequenceId ?? ''],
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getSequenceVideoVariantsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

// All image FrameVariant rows for a sequence (#547). Used by the header image
// dropdown for sequence-wide per-model coverage, and by the scenes view to
// resolve each frame's displayed image through the active model's variant. Key
// matches the scenes-view query + the image:progress cache invalidation.
export function useSequenceImageVariants(sequenceId?: string) {
  return useQuery<FrameVariant[]>({
    queryKey: ['sequence-image-variants', sequenceId ?? ''],
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getSequenceImageVariantsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
  });
}

// Hook to fetch the live (non-discarded) divergent alternates for a sequence.
// The corner-dot indicator and inline banner both filter this list per frame.
export function useDivergentVariants(
  sequenceId?: string,
  options?: { refetchInterval?: number | false }
) {
  return useQuery<FrameVariant[]>({
    queryKey: frameKeys.divergentVariants(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getDivergentVariantsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

// Promote a divergent alternate to the live primary slot.
export function usePromoteVariantToPrimary() {
  const queryClient = useQueryClient();
  return useMutation<
    { frame: Frame; variantId: string },
    Error,
    { sequenceId: string; frameId: string; variantId: string }
  >({
    mutationFn: async (input) => {
      const result = await promoteVariantFn({ data: input });
      return result;
    },
    onSuccess: async ({ frame }, { sequenceId }) => {
      queryClient.setQueryData(frameKeys.detail(frame.id), frame);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: frameKeys.list(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: frameKeys.divergentVariants(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: ['sequence-image-variants', sequenceId],
        }),
      ]);
    },
  });
}

// Discard a divergent alternate (sets discarded_at). Pairs with useUndiscard
// for the toast Undo action.
export function useDiscardVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { variantId: string; discardedAt: Date },
    Error,
    { sequenceId: string; frameId: string; variantId: string }
  >({
    mutationFn: async (input) => discardVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: frameKeys.divergentVariants(sequenceId),
      });
    },
  });
}

export function useUndiscardVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { variantId: string },
    Error,
    { sequenceId: string; frameId: string; variantId: string }
  >({
    mutationFn: async (input) => undiscardVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: frameKeys.divergentVariants(sequenceId),
      });
    },
  });
}

// Hook for listing frames by sequence with optional auto-refresh
export function useFramesBySequence(
  sequenceId?: string,
  options?: {
    refetchInterval?: number | false;
    staleTime?: number;
  }
) {
  return useQuery<Frame[]>({
    queryKey: frameKeys.list(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      const data = await getFramesFn({ data: { sequenceId } });
      return data;
    },
    staleTime: options?.staleTime ?? 30_000, // Realtime events update the cache; polling is a fallback
    // Callers pass an explicit refetchInterval when needed (e.g. scenes-view
    // passes 2000 when realtime has failed). No default polling — realtime
    // events keep the cache fresh via updateQueryCacheFromEvent.
    refetchInterval: options?.refetchInterval ?? false,
    refetchOnMount: 'always', // Always refetch on mount to ensure fresh data
    refetchOnWindowFocus: true, // Refetch when window regains focus
    enabled: !!sequenceId,
  });
}

// Hook for generating variant images for a frame
export function useGenerateVariants() {
  const queryClient = useQueryClient();

  return useMutation<{ workflowRunId: string }, Error, GenerateVariantInput>({
    mutationFn: async (input: GenerateVariantInput) => {
      const { sequenceId, frameId, model, imageSize, numImages, seed } = input;

      const result = await generateFrameVariantsFn({
        data: {
          sequenceId,
          frameId,
          model,
          imageSize,
          numImages,
          seed,
        },
      });

      return { workflowRunId: result.workflowRunId };
    },
    onSuccess: async (_, { sequenceId, frameId }) => {
      // Optimistically update frame status to 'generating'
      queryClient.setQueryData<Frame>(frameKeys.detail(frameId), (oldFrame) => {
        if (!oldFrame) return oldFrame;
        return {
          ...oldFrame,
          variantImageStatus: 'generating' as const,
        };
      });

      queryClient.setQueryData<Frame[]>(
        frameKeys.list(sequenceId),
        (oldFrames) => {
          if (!oldFrames) return oldFrames;
          return oldFrames.map((f) =>
            f.id === frameId
              ? {
                  ...f,
                  variantImageStatus: 'generating' as const,
                }
              : f
          );
        }
      );

      // Invalidate queries to pick up server updates
      await queryClient.invalidateQueries({
        queryKey: frameKeys.detail(frameId),
      });

      await queryClient.invalidateQueries({
        queryKey: frameKeys.list(sequenceId),
      });
    },
  });
}

// Hook for selecting a variant panel and upscaling it
export function useSelectVariant() {
  const queryClient = useQueryClient();

  return useMutation<
    { frameId: string; thumbnailUrl: string; variantIndex: number },
    Error,
    SelectVariantInput
  >({
    mutationFn: async (input: SelectVariantInput) => {
      const { sequenceId, frameId, variantIndex } = input;
      const result = await selectFrameVariantFn({
        data: {
          sequenceId,
          frameId,
          variantIndex,
        },
      });

      return {
        frameId: result.frameId,
        thumbnailUrl: result.thumbnailUrl,
        variantIndex: result.variantIndex,
      };
    },
    onSuccess: async (data, { sequenceId, frameId }) => {
      // Update frame queries with new thumbnail
      queryClient.setQueryData<Frame>(frameKeys.detail(frameId), (oldFrame) => {
        if (!oldFrame) return oldFrame;
        return {
          ...oldFrame,
          thumbnailUrl: data.thumbnailUrl,
          thumbnailStatus: 'generating' as const, // Upscale is running
        };
      });

      queryClient.setQueryData<Frame[]>(
        frameKeys.list(sequenceId),
        (oldFrames) => {
          if (!oldFrames) return oldFrames;
          return oldFrames.map((f) =>
            f.id === frameId
              ? {
                  ...f,
                  thumbnailUrl: data.thumbnailUrl,
                  thumbnailStatus: 'generating' as const,
                }
              : f
          );
        }
      );

      // Invalidate queries to ensure consistency
      await queryClient.invalidateQueries({
        queryKey: frameKeys.detail(frameId),
      });

      await queryClient.invalidateQueries({
        queryKey: frameKeys.list(sequenceId),
      });
    },
  });
}

// Hook for setting a frame's image from an existing variant
export function useSetImageFromVariant() {
  const queryClient = useQueryClient();

  return useMutation<
    { frameId: string; thumbnailUrl: string },
    Error,
    { sequenceId: string; frameId: string; model: string }
  >({
    mutationFn: async (input) => {
      return setImageFromVariantFn({ data: input });
    },
    onMutate: async ({ sequenceId, frameId }) => {
      await queryClient.cancelQueries({
        queryKey: frameKeys.detail(frameId),
      });
      await queryClient.cancelQueries({
        queryKey: frameKeys.list(sequenceId),
      });
    },
    onSuccess: async (data, { sequenceId, frameId, model }) => {
      queryClient.setQueryData<Frame>(frameKeys.detail(frameId), (oldFrame) => {
        if (!oldFrame) return oldFrame;
        return {
          ...oldFrame,
          thumbnailUrl: data.thumbnailUrl,
          thumbnailStatus: 'completed' as const,
          imageModel: model,
          videoUrl: null,
          videoStatus: 'pending' as const,
        };
      });

      queryClient.setQueryData<Frame[]>(
        frameKeys.list(sequenceId),
        (oldFrames) => {
          if (!oldFrames) return oldFrames;
          return oldFrames.map((f) =>
            f.id === frameId
              ? {
                  ...f,
                  thumbnailUrl: data.thumbnailUrl,
                  thumbnailStatus: 'completed' as const,
                  imageModel: model,
                  videoUrl: null,
                  videoStatus: 'pending' as const,
                }
              : f
          );
        }
      );

      await queryClient.invalidateQueries({
        queryKey: frameKeys.detail(frameId),
      });
      await queryClient.invalidateQueries({
        queryKey: frameKeys.list(sequenceId),
      });
    },
  });
}

// Hook for setting a frame's video from an existing variant (#545) — the
// motion analog of useSetImageFromVariant. Promotes a model's video variant to
// the primary frames.video* columns and refreshes the video-variant cache.
export function useSetVideoFromVariant() {
  const queryClient = useQueryClient();

  return useMutation<
    { frameId: string; videoUrl: string },
    Error,
    { sequenceId: string; frameId: string; model: string }
  >({
    mutationFn: async (input) => {
      return setVideoFromVariantFn({ data: input });
    },
    onMutate: async ({ sequenceId, frameId }) => {
      await queryClient.cancelQueries({
        queryKey: frameKeys.detail(frameId),
      });
      await queryClient.cancelQueries({
        queryKey: frameKeys.list(sequenceId),
      });
    },
    onSuccess: async (data, { sequenceId, frameId, model }) => {
      queryClient.setQueryData<Frame>(frameKeys.detail(frameId), (oldFrame) => {
        if (!oldFrame) return oldFrame;
        return {
          ...oldFrame,
          videoUrl: data.videoUrl,
          videoStatus: 'completed' as const,
          motionModel: model,
        };
      });

      queryClient.setQueryData<Frame[]>(
        frameKeys.list(sequenceId),
        (oldFrames) => {
          if (!oldFrames) return oldFrames;
          return oldFrames.map((f) =>
            f.id === frameId
              ? {
                  ...f,
                  videoUrl: data.videoUrl,
                  videoStatus: 'completed' as const,
                  motionModel: model,
                }
              : f
          );
        }
      );

      await queryClient.invalidateQueries({
        queryKey: frameKeys.detail(frameId),
      });
      await queryClient.invalidateQueries({
        queryKey: frameKeys.list(sequenceId),
      });
      await queryClient.invalidateQueries({
        queryKey: ['sequence-video-variants', sequenceId],
      });
    },
  });
}
