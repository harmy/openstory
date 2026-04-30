/**
 * Hook that drives the browser-side merge:
 *   1. Reserve an upload URL via `requestMergedUploadUrlFn` (status → 'merging').
 *   2. Run the Mediabunny pipeline against the team's frames + music URL.
 *   3. PUT the resulting Blob to the reserved URL.
 *   4. Commit via `commitMergedVideoFn` (status → 'completed', URL set).
 *   5. On any failure, post via `failMergedVideoFn` and surface a toast.
 *
 * The hook returns the running state + a `start()` function. PostHog flag
 * gating (`browserMerge`) is exposed as `isEnabled` so the caller can hide
 * the entry point when the flag is off.
 */

import { useFramesBySequence } from '@/hooks/use-frames';
import { sequenceKeys } from '@/hooks/use-sequences';
import { mergeSequence, uploadMergedBlob } from '@/lib/browser-merge';
import type { MergeProgress } from '@/lib/browser-merge';
import {
  commitMergedVideoFn,
  failMergedVideoFn,
  requestMergedUploadUrlFn,
} from '@/functions/merged-video';
import { useQueryClient } from '@tanstack/react-query';
import { usePostHog } from '@posthog/react';
import { useCallback, useRef, useState } from 'react';
import { toast } from 'sonner';
import type { Sequence } from '@/types/database';

export type BrowserMergeState = {
  isEnabled: boolean;
  isRunning: boolean;
  progress: MergeProgress | null;
  start: () => void;
  abort: () => void;
};

const FLAG_NAME = 'browserMerge';

export function useBrowserMerge(sequence: Sequence): BrowserMergeState {
  const posthog = usePostHog();
  const queryClient = useQueryClient();
  const isEnabled = Boolean(posthog.isFeatureEnabled(FLAG_NAME));

  const { data: frames } = useFramesBySequence(sequence.id);

  const [isRunning, setIsRunning] = useState(false);
  const [progress, setProgress] = useState<MergeProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const start = useCallback(() => {
    if (isRunning) return;
    if (!frames || frames.length === 0) {
      toast.error('Cannot merge: this sequence has no frames yet.');
      return;
    }
    const scenes = frames
      .filter((f): f is typeof f & { videoUrl: string } => Boolean(f.videoUrl))
      .map((f) => ({ orderIndex: f.orderIndex, videoUrl: f.videoUrl }));
    if (scenes.length === 0) {
      toast.error('Cannot merge: no scene videos are ready.');
      return;
    }
    if (scenes.length !== frames.length) {
      toast.error(
        `Cannot merge yet: ${frames.length - scenes.length} of ${frames.length} scenes are still generating.`
      );
      return;
    }

    const controller = new AbortController();
    abortRef.current = controller;
    setIsRunning(true);
    setProgress(null);

    void runMerge({
      sequenceId: sequence.id,
      musicUrl: sequence.musicUrl ?? null,
      scenes,
      signal: controller.signal,
      onProgress: setProgress,
    })
      .then(() => {
        toast.success('Merged video ready.');
        posthog.capture('browser_merge_completed', {
          sequence_id: sequence.id,
          scene_count: scenes.length,
        });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const message =
          error instanceof Error ? error.message : 'Browser merge failed';
        toast.error(message);
        posthog.captureException(error, { sequence_id: sequence.id });
      })
      .finally(() => {
        setIsRunning(false);
        setProgress(null);
        abortRef.current = null;
        void queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequence.id),
        });
      });
  }, [frames, isRunning, posthog, queryClient, sequence.id, sequence.musicUrl]);

  const abort = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { isEnabled, isRunning, progress, start, abort };
}

async function runMerge(args: {
  sequenceId: string;
  musicUrl: string | null;
  scenes: Array<{ orderIndex: number; videoUrl: string }>;
  signal: AbortSignal;
  onProgress: (p: MergeProgress) => void;
}): Promise<void> {
  const { sequenceId, musicUrl, scenes, signal, onProgress } = args;

  const reservation = await requestMergedUploadUrlFn({ data: { sequenceId } });

  try {
    const { blob } = await mergeSequence({
      scenes,
      musicUrl,
      onProgress,
      signal,
    });

    await uploadMergedBlob({
      blob,
      uploadUrl: reservation.uploadUrl,
      contentType: reservation.contentType,
      signal,
    });

    await commitMergedVideoFn({
      data: { sequenceId, path: reservation.path },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Browser merge failed';
    await failMergedVideoFn({ data: { sequenceId, error: message } }).catch(
      () => {}
    );
    throw error;
  }
}
