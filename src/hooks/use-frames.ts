import type { Frame } from '@/types/database';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import {
  getFramesFn,
  getFrameFn,
  createFrameFn,
  createFramesBulkFn,
  updateFrameFn,
  deleteFrameFn,
  deleteFramesBySequenceFn,
  reorderFramesFn,
} from '@/functions/frames';
import {
  generateFramesFn,
  generateFrameImageFn,
  generateFrameVariantsFn,
  selectFrameVariantFn,
  setImageFromVariantFn,
} from '@/functions/frame-image';
import type { GenerateVariantInput as SchemaGenerateVariantInput } from '@/lib/schemas/frame.schemas';
import type { Scene } from '@/lib/ai/scene-analysis.schema';

type CreateFrameInput = {
  sequenceId: string;
  description: string;
  orderIndex: number;
  thumbnailUrl?: string;
  videoUrl?: string;
  durationMs?: number;
  metadata?: Scene;
};

type UpdateFrameInput = {
  id: string;
  description?: string;
  orderIndex?: number;
  thumbnailUrl?: string | null;
  videoUrl?: string | null;
  durationMs?: number | null;
  metadata?: Scene;
};

type GenerateFramesInput = {
  sequenceId: string;
};

type RegenerateFrameInput = {
  sequenceId: string;
  frameId: string;
  regenerateDescription?: boolean;
  regenerateThumbnail?: boolean;
};

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
  imageModels: (sequenceId: string) =>
    [...frameKeys.all, 'image-models', sequenceId] as const,
};

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

// Hook for getting single frame
export function useFrame(sequenceId: string, frameId: string) {
  return useQuery<Frame>({
    queryKey: frameKeys.detail(frameId),
    queryFn: async () => {
      return getFrameFn({ data: { sequenceId, frameId } });
    },
    staleTime: 5 * 60 * 1000,
    enabled: !!sequenceId && !!frameId,
  });
}

// Hook for creating frame
export function useCreateFrame() {
  const queryClient = useQueryClient();

  return useMutation<Frame, Error, CreateFrameInput>({
    mutationFn: async (input: CreateFrameInput) => {
      const { sequenceId, description, orderIndex, durationMs, ...rest } =
        input;
      const data = await createFrameFn({
        data: {
          sequenceId,
          description,
          orderIndex,
          durationMs: durationMs ?? null,
          ...rest,
        } satisfies Parameters<typeof createFrameFn>[0]['data'],
      });
      return data;
    },
    onSuccess: async (data) => {
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (data?.sequenceId) {
        await queryClient.invalidateQueries({
          queryKey: frameKeys.list(data.sequenceId),
        });
      }
    },
  });
}

// Hook for updating frame
export function useUpdateFrame() {
  const queryClient = useQueryClient();

  return useMutation<Frame, Error, UpdateFrameInput & { sequenceId: string }>({
    mutationFn: async (input) => {
      const { id, sequenceId, metadata: _metadata, ...updateData } = input;
      const data = await updateFrameFn({
        data: {
          sequenceId,
          frameId: id,
          ...updateData,
        } as Parameters<typeof updateFrameFn>[0]['data'],
      });
      if (!data) {
        throw new Error(`Frame ${id} not found`);
      }
      return data;
    },
    onSuccess: async (data) => {
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (data?.id) {
        queryClient.setQueryData(frameKeys.detail(data.id), data);
      }
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (data?.sequenceId) {
        await queryClient.invalidateQueries({
          queryKey: frameKeys.list(data.sequenceId),
        });
      }
    },
  });
}

// Hook for deleting frame
export function useDeleteFrame() {
  const queryClient = useQueryClient();

  return useMutation<
    { frameId: string; sequenceId?: string },
    Error,
    { sequenceId: string; frameId: string }
  >({
    mutationFn: async ({ sequenceId, frameId }) => {
      const frameData = queryClient.getQueryData<Frame>(
        frameKeys.detail(frameId)
      );

      await deleteFrameFn({ data: { sequenceId, frameId } });

      return { frameId, sequenceId: frameData?.sequenceId };
    },
    onSuccess: async ({ frameId, sequenceId }) => {
      queryClient.removeQueries({ queryKey: frameKeys.detail(frameId) });
      if (sequenceId) {
        await queryClient.invalidateQueries({
          queryKey: frameKeys.list(sequenceId),
        });
      }
    },
  });
}

// Hook for reordering frames
export function useReorderFrames() {
  const queryClient = useQueryClient();

  return useMutation<
    { sequenceId: string },
    Error,
    {
      sequenceId: string;
      frameOrders: Array<{ id: string; orderIndex: number }>;
    },
    { previousFrames: Frame[] | undefined; sequenceId: string }
  >({
    mutationFn: async ({
      sequenceId,
      frameOrders,
    }: {
      sequenceId: string;
      frameOrders: Array<{ id: string; orderIndex: number }>;
    }) => {
      await reorderFramesFn({ data: { sequenceId, frameOrders } });
      return { sequenceId };
    },
    onMutate: async ({ sequenceId, frameOrders }) => {
      await queryClient.cancelQueries({
        queryKey: frameKeys.list(sequenceId),
      });

      const previousFrames = queryClient.getQueryData<Frame[]>(
        frameKeys.list(sequenceId)
      );

      if (previousFrames) {
        const reorderedFrames = previousFrames
          .map((frame) => {
            const newOrder = frameOrders.find((o) => o.id === frame.id);
            return newOrder
              ? { ...frame, orderIndex: newOrder.orderIndex }
              : frame;
          })
          .sort((a, b) => a.orderIndex - b.orderIndex);

        queryClient.setQueryData(frameKeys.list(sequenceId), reorderedFrames);
      }

      return { previousFrames, sequenceId };
    },
    onError: (_, __, context) => {
      if (context?.previousFrames && context.sequenceId) {
        queryClient.setQueryData(
          frameKeys.list(context.sequenceId),
          context.previousFrames
        );
      }
    },
    onSettled: async (_, __, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: frameKeys.list(sequenceId),
      });
    },
  });
}

// Hook for bulk creating frames
export function useBulkCreateFrames() {
  const queryClient = useQueryClient();

  return useMutation<
    Frame[],
    Error,
    {
      sequenceId: string;
      frames: Omit<CreateFrameInput, 'sequenceId'>[];
    }
  >({
    mutationFn: async ({
      sequenceId,
      frames,
    }: {
      sequenceId: string;
      frames: Omit<CreateFrameInput, 'sequenceId'>[];
    }) => {
      // Transform frames to match server function schema types
      const transformedFrames = frames.map((f) => ({
        ...f,
        durationMs: f.durationMs ?? null,
      }));
      const data = await createFramesBulkFn({
        data: {
          sequenceId,
          frames: transformedFrames,
        } satisfies Parameters<typeof createFramesBulkFn>[0]['data'],
      });
      return data;
    },
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: frameKeys.list(sequenceId),
      });
    },
  });
}

// Hook for deleting all frames in a sequence
export function useDeleteFramesBySequence() {
  const queryClient = useQueryClient();

  return useMutation<string, Error, string>({
    mutationFn: async (sequenceId: string) => {
      await deleteFramesBySequenceFn({ data: { sequenceId } });
      return sequenceId;
    },
    onSuccess: async (sequenceId) => {
      queryClient.setQueryData(frameKeys.list(sequenceId), []);
      await queryClient.invalidateQueries({
        queryKey: frameKeys.list(sequenceId),
      });
    },
  });
}

// Hook for generating frames with AI
export function useGenerateFrames() {
  const queryClient = useQueryClient();

  return useMutation<
    { workflowRunId: string },
    Error,
    GenerateFramesInput,
    { previousFrames: Frame[] | undefined; sequenceId: string }
  >({
    mutationFn: async (input: GenerateFramesInput) => {
      const result = await generateFramesFn({
        data: { sequenceId: input.sequenceId },
      });
      return { workflowRunId: result.workflowRunId };
    },
    onMutate: async ({ sequenceId }) => {
      await queryClient.cancelQueries({
        queryKey: frameKeys.list(sequenceId),
      });

      const previousFrames = queryClient.getQueryData<Frame[]>(
        frameKeys.list(sequenceId)
      );

      return { previousFrames, sequenceId };
    },
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: frameKeys.list(sequenceId),
      });
    },
    onError: (_, __, context) => {
      if (context?.previousFrames && context.sequenceId) {
        queryClient.setQueryData(
          frameKeys.list(context.sequenceId),
          context.previousFrames
        );
      }
    },
  });
}

// Hook for regenerating a single frame
export function useRegenerateFrame() {
  const queryClient = useQueryClient();

  return useMutation<{ workflowRunId: string }, Error, RegenerateFrameInput>({
    mutationFn: async (input: RegenerateFrameInput) => {
      const { sequenceId, frameId, ...body } = input;

      const result = await generateFrameImageFn({
        data: {
          sequenceId,
          frameId,
          ...body,
        },
      });

      return { workflowRunId: result.workflowRunId };
    },
    onSuccess: async (_, { sequenceId, frameId }) => {
      await queryClient.invalidateQueries({
        queryKey: frameKeys.detail(frameId),
      });

      await queryClient.invalidateQueries({
        queryKey: frameKeys.list(sequenceId),
      });
    },
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

// Hook to track preview image generation status for frames
export function useFramePreviewStatus(frames: Frame[]) {
  // Get frames that might be generating previews (no image URLs but were recently created)
  const framesNeedingPreviews = useMemo(() => {
    return frames.filter((frame) => {
      if (frame.thumbnailUrl || frame.previewThumbnailUrl) return false; // Already has an image

      // Check if frame was created recently (within last 2 minutes for faster timeout)
      const createdAt = new Date(frame.createdAt).getTime();
      const now = Date.now();
      const twoMinutesAgo = now - 2 * 60 * 1000;

      return createdAt > twoMinutesAgo;
    });
  }, [frames]);

  // Auto-refresh frames list when there are frames potentially generating previews
  const { data: refreshedFrames = frames } = useFramesBySequence(
    frames.length > 0 ? frames[0].sequenceId : '',
    {
      refetchInterval: framesNeedingPreviews.length > 0 ? 5000 : false, // Fallback poll
      staleTime: 500, // Shorter stale time for preview updates
    }
  );

  // Return status map for each frame
  return useMemo(() => {
    const statusMap = new Map<
      string,
      { isGenerating: boolean; hasPreview: boolean }
    >();

    refreshedFrames.forEach((frame) => {
      const hasPreview = !!frame.previewThumbnailUrl;

      // Check if this frame should show as generating
      let isGenerating = false;
      if (!frame.thumbnailUrl && !frame.previewThumbnailUrl) {
        const createdAt = new Date(frame.createdAt).getTime();
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        const updatedAt = frame.updatedAt
          ? new Date(frame.updatedAt).getTime()
          : createdAt;
        const now = Date.now();
        const twoMinutesAgo = now - 2 * 60 * 1000;

        // Only show as generating if created recently
        isGenerating = createdAt > twoMinutesAgo || updatedAt > twoMinutesAgo;
      }

      statusMap.set(frame.id, {
        isGenerating,
        hasPreview,
      });
    });

    return statusMap;
  }, [refreshedFrames]);
}
