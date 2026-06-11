/**
 * Failure Analysis Utility
 * Analyzes frames + sequence to determine what failed and whether smart retry is possible.
 */

import type { Frame } from '@/lib/db/schema/frames';
import type { Sequence } from '@/lib/db/schema/sequences';

type FailureCategory =
  | 'image'
  | 'motion'
  | 'music'
  | 'motion-prompts'
  | 'music-prompt';

type FrameFailure = {
  frameId: string;
  orderIndex: number;
  sceneTitle: string;
  error: string | null;
};

type FailureGroup = {
  category: FailureCategory;
  label: string;
  frames: FrameFailure[];
  error?: string | null;
};

export type FailureSummary = {
  requiresFullRetry: boolean;
  headline: string;
  groups: FailureGroup[];
  totalFailures: number;
  hasFailed: boolean;
  error?: string | null;
};

function getSceneTitle(frame: Frame): string {
  return frame.metadata?.metadata?.title || `Scene ${frame.orderIndex + 1}`;
}

function buildHeadline(
  groups: FailureGroup[],
  requiresFullRetry: boolean
): string {
  if (groups.length === 0) {
    if (requiresFullRetry)
      return 'Generation failed \u2014 full retry required';
    return 'No failures detected';
  }

  if (requiresFullRetry) {
    const promptGroups = groups.filter(
      (g) => g.category === 'motion-prompts' || g.category === 'music-prompt'
    );
    if (promptGroups.length > 0) {
      const names = promptGroups.map((g) => g.label).join(' and ');
      return `${names} \u2014 full retry required`;
    }
    return 'Generation failed \u2014 full retry required';
  }

  const parts: string[] = [];
  for (const group of groups) {
    if (group.category === 'image') {
      parts.push(
        `${group.frames.length} image${group.frames.length !== 1 ? 's' : ''} failed`
      );
    } else if (group.category === 'motion') {
      parts.push(
        `${group.frames.length} motion video${group.frames.length !== 1 ? 's' : ''} failed`
      );
    } else if (group.category === 'music') {
      parts.push('music generation failed');
    } else if (group.category === 'music-prompt') {
      parts.push('music prompt generation failed');
    }
  }

  return parts.join(' and ');
}

export function analyzeFailures(
  frames: Frame[],
  sequence: Sequence
): FailureSummary {
  const groups: FailureGroup[] = [];
  let requiresFullRetry = false;

  // No frames → script analysis failed → full retry
  if (frames.length === 0 && sequence.status === 'failed') {
    return {
      requiresFullRetry: true,
      headline: 'Generation failed \u2014 full retry required',
      groups: [],
      totalFailures: 1,
      hasFailed: true,
      error: sequence.statusError,
    };
  }

  // Failed images
  const failedImageFrames = frames.filter(
    (f) => f.thumbnailStatus === 'failed'
  );
  if (failedImageFrames.length > 0) {
    groups.push({
      category: 'image',
      label: `${failedImageFrames.length} of ${frames.length} images failed`,
      frames: failedImageFrames.map((f) => ({
        frameId: f.id,
        orderIndex: f.orderIndex,
        sceneTitle: getSceneTitle(f),
        error: f.thumbnailError,
      })),
    });
  }

  // Failed motion (only frames with thumbnails AND motionPrompt)
  const failedMotionFrames = frames.filter(
    (f) => f.videoStatus === 'failed' && f.thumbnailUrl && f.motionPrompt
  );
  if (failedMotionFrames.length > 0) {
    groups.push({
      category: 'motion',
      label: `${failedMotionFrames.length} of ${frames.length} motion videos failed`,
      frames: failedMotionFrames.map((f) => ({
        frameId: f.id,
        orderIndex: f.orderIndex,
        sceneTitle: getSceneTitle(f),
        error: f.videoError,
      })),
    });
  }

  // Detect missing motion prompts (images completed but no motionPrompt)
  const framesWithImageButNoMotionPrompt = frames.filter(
    (f) => f.thumbnailStatus === 'completed' && !f.motionPrompt
  );
  if (
    framesWithImageButNoMotionPrompt.length > 0 &&
    sequence.status === 'failed'
  ) {
    requiresFullRetry = true;
    groups.push({
      category: 'motion-prompts',
      label: 'Motion prompts were not generated',
      frames: framesWithImageButNoMotionPrompt.map((f) => ({
        frameId: f.id,
        orderIndex: f.orderIndex,
        sceneTitle: getSceneTitle(f),
        error: null,
      })),
    });
  }

  // Failed music (only if musicPrompt exists)
  if (sequence.musicStatus === 'failed' && sequence.musicPrompt) {
    groups.push({
      category: 'music',
      label: 'Music generation failed',
      frames: [],
      error: sequence.musicError,
    });
  }

  // Detect missing music prompt
  if (sequence.status === 'failed' && !sequence.musicPrompt) {
    // Only flag as needing full retry if we have frames (otherwise already caught above)
    if (frames.length > 0 && sequence.musicStatus !== 'completed') {
      groups.push({
        category: 'music-prompt',
        label: 'Music prompt was not generated',
        frames: [],
      });
    }
  }

  // Mixed case: retryable failures + missing prompts → full retry wins
  if (
    requiresFullRetry &&
    groups.some((g) => g.category === 'image' || g.category === 'motion')
  ) {
    // Full retry re-runs everything including generation
  }

  // Catch-all: sequence failed but no specific failures identified
  if (sequence.status === 'failed' && groups.length === 0) {
    requiresFullRetry = true;
  }

  const totalFailures = groups.reduce(
    (sum, g) => sum + Math.max(g.frames.length, 1),
    0
  );

  const hasFailed = groups.length > 0 || sequence.status === 'failed';

  return {
    requiresFullRetry,
    headline: buildHeadline(groups, requiresFullRetry),
    groups,
    totalFailures,
    hasFailed,
    error: sequence.statusError,
  };
}
