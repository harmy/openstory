export { mergeSequence } from './merge-sequence';
export {
  BrowserMergeUnsupportedError,
  probeBrowserMergeCapabilities,
} from './probe';
export {
  DEFAULT_MUSIC_LOUDNESS_LUFS,
  applyGain,
  gainToTarget,
  integratedLoudnessLUFS,
} from './loudness-normalize';
export { assembleChannelData } from './mix-audio-tracks';
export type {
  MergeProgress,
  MergeProgressCallback,
  MergePhase,
  MergeSequenceInput,
  MergeSequenceResult,
  SceneInput,
} from './types';
