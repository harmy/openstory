import {
  analyzeDraftElementFn,
  deleteSequenceElementFn,
  finalizeElementUploadFn,
  listSequenceElementsFn,
  presignDraftElementUploadFn,
  presignElementUploadFn,
  renameSequenceElementTokenFn,
} from '@/functions/sequence-elements';
import type { SequenceElement } from '@/lib/db/schema';
import { putToR2 } from '@/lib/utils/upload';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const sequenceElementKeys = {
  all: ['sequence-elements'] as const,
  bySequence: (sequenceId: string) =>
    ['sequence-elements', sequenceId] as const,
};

export function useSequenceElements(sequenceId: string | undefined) {
  return useQuery({
    queryKey: sequenceId
      ? sequenceElementKeys.bySequence(sequenceId)
      : ['sequence-elements', 'none'],
    queryFn: () =>
      listSequenceElementsFn({ data: { sequenceId: sequenceId ?? '' } }),
    enabled: Boolean(sequenceId),
    // Poll while vision is still analyzing
    refetchInterval: (query) => {
      const data = query.state.data as SequenceElement[] | undefined;
      if (!data) return false;
      const hasPending = data.some(
        (el) => el.visionStatus === 'pending' || el.visionStatus === 'analyzing'
      );
      return hasPending ? 2000 : false;
    },
  });
}

/**
 * Upload an element file into an existing sequence: presign → R2 → finalize.
 */
export function useUploadElementToSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      file: File;
      sequenceId: string;
      onProgress?: (percent: number) => void;
    }) => {
      const presign = await presignElementUploadFn({
        data: { filename: data.file.name, sequenceId: data.sequenceId },
      });
      await putToR2(
        presign.uploadUrl,
        data.file,
        presign.contentType,
        data.onProgress
      );
      const element = await finalizeElementUploadFn({
        data: {
          sequenceId: data.sequenceId,
          publicUrl: presign.publicUrl,
          path: presign.path,
          filename: data.file.name,
        },
      });
      return element;
    },
    onSuccess: (_element, variables) => {
      void queryClient.invalidateQueries({
        queryKey: sequenceElementKeys.bySequence(variables.sequenceId),
      });
    },
  });
}

export type DraftElementUpload = {
  tempPath: string;
  tempPublicUrl: string;
  filename: string;
  token: string;
  /**
   * Vision-LLM description, populated during draft upload so the Generate
   * button can gate on vision-readiness. Null when the analyze call failed
   * or was skipped (e.g. E2E replay) — promoteTempElements falls back to
   * triggering the persisted vision workflow in that case.
   */
  description: string | null;
  consistencyTag: string | null;
};

/**
 * Upload an element file as a *draft* (before a sequence exists). Returns the
 * temp storage path + public URL so the caller can persist it in local state
 * and pass it to the createSequence mutation for promotion.
 *
 * Runs vision analysis inline after the upload resolves so promoteTempElements
 * can skip the async element-vision workflow on the happy path. If the vision
 * call fails we still resolve with `description: null` — the upload itself
 * succeeded and the persisted-mode fallback in promoteTempElements will kick
 * the workflow on promotion.
 */
export function useUploadDraftElement() {
  return useMutation({
    mutationFn: async (data: {
      file: File;
      onProgress?: (percent: number) => void;
      onAnalyzingChange?: (analyzing: boolean) => void;
    }): Promise<DraftElementUpload> => {
      const presign = await presignDraftElementUploadFn({
        data: { filename: data.file.name },
      });
      await putToR2(
        presign.uploadUrl,
        data.file,
        presign.contentType,
        data.onProgress
      );
      const token = data.file.name
        .replace(/\.[^.]+$/, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      const finalToken = token.length > 0 ? token : 'ELEMENT';

      data.onAnalyzingChange?.(true);
      let description: string | null = null;
      let consistencyTag: string | null = null;
      try {
        const result = await analyzeDraftElementFn({
          data: {
            publicUrl: presign.publicUrl,
            filename: data.file.name,
            token: finalToken,
          },
        });
        description = result.description;
        consistencyTag = result.consistencyTag;
      } catch (err) {
        console.warn(
          '[useUploadDraftElement] Vision analysis failed; falling back to async workflow on promotion',
          err
        );
      } finally {
        data.onAnalyzingChange?.(false);
      }

      return {
        tempPath: presign.path,
        tempPublicUrl: presign.publicUrl,
        filename: data.file.name,
        token: finalToken,
        description,
        consistencyTag,
      };
    },
  });
}

export function useDeleteSequenceElement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { elementId: string; sequenceId: string }) =>
      deleteSequenceElementFn({ data }),
    onSuccess: (_res, variables) => {
      void queryClient.invalidateQueries({
        queryKey: sequenceElementKeys.bySequence(variables.sequenceId),
      });
    },
  });
}

export function useRenameSequenceElementToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      elementId: string;
      sequenceId: string;
      token: string;
    }) => renameSequenceElementTokenFn({ data }),
    onSuccess: (_res, variables) => {
      void queryClient.invalidateQueries({
        queryKey: sequenceElementKeys.bySequence(variables.sequenceId),
      });
    },
  });
}
