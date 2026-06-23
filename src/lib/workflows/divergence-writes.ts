import type { NewShot, NewShotVariant } from '@/lib/db/schema';

/**
 * Reverts to apply when a snapshot-pattern image workflow detects divergence
 * after speculatively writing the primary `frames` + primary `frame_variants`
 * row at start. Each consumer pairs this with its own divergent-alternate
 * INSERT payload.
 */
export function buildDivergentRevertWrites(): {
  frame: Partial<NewShot>;
  primaryRevert: Partial<NewShotVariant>;
} {
  return {
    frame: {
      thumbnailUrl: null,
      thumbnailPath: null,
      thumbnailStatus: 'pending',
      thumbnailWorkflowRunId: null,
      thumbnailGeneratedAt: null,
      thumbnailError: null,
      thumbnailInputHash: null,
    },
    primaryRevert: {
      url: null,
      storagePath: null,
      previewUrl: null,
      status: 'pending',
      workflowRunId: null,
      generatedAt: null,
      error: null,
      inputHash: null,
    },
  };
}
