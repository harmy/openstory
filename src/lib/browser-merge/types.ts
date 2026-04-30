/**
 * Shared types for the browser-side merge pipeline.
 */

export type MergePhase = 'fetch' | 'decode' | 'mix' | 'encode' | 'finalize';

export type MergeProgress = {
  phase: MergePhase;
  /** Completed work in `phase`'s units. */
  completed: number;
  /** Total work in `phase`'s units (or 0 if indeterminate). */
  total: number;
};

export type MergeProgressCallback = (progress: MergeProgress) => void;

export type SceneInput = {
  /** Order in the final timeline. */
  orderIndex: number;
  /** Public R2 URL of the scene MP4. */
  videoUrl: string;
};

export type MergeSequenceInput = {
  /** Scenes in any order — the merger sorts by `orderIndex`. */
  scenes: SceneInput[];
  /** Public R2 URL of the music MP3/MP4 — `null` if no music. */
  musicUrl: string | null;
  /** Optional progress callback. */
  onProgress?: MergeProgressCallback;
  /**
   * Optional abort signal. When aborted, the merge throws and disposes
   * partial Mediabunny resources.
   */
  signal?: AbortSignal;
};

export type MergeSequenceResult = {
  /** Final MP4 ready to upload. */
  blob: Blob;
  /** Total duration of the merged video, in seconds. */
  durationSeconds: number;
};
