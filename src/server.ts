/**
 * Custom TanStack Start server entry.
 *
 * `./instrumentation` is imported first so OpenTelemetry is active before
 * the default handler's transitive route / server-function graph loads.
 */

import './instrumentation';
import handler from '@tanstack/react-start/server-entry';

// Re-export Cloudflare Workflow entrypoint classes so the Worker bundle
// includes them. Each must have a matching entry in `wrangler.jsonc` under
// `workflows[]`. See docs/investigations/cloudflare-workflows-poc.md.
export { ImageWorkflow } from '@/lib/workflows/cf/image-workflow';
export { ElementVisionWorkflow } from '@/lib/workflows/cf/element-vision-workflow';
export { MusicWorkflow } from '@/lib/workflows/cf/music-workflow';
export { MergeAudioVideoWorkflow } from '@/lib/workflows/cf/merge-audio-video-workflow';
export { MergeVideoWorkflow } from '@/lib/workflows/cf/merge-video-workflow';
export { MotionWorkflow } from '@/lib/workflows/cf/motion-workflow';
export { MotionBatchWorkflow } from '@/lib/workflows/cf/motion-batch-workflow';
export { CharacterSheetWorkflow } from '@/lib/workflows/cf/character-sheet-workflow';
export { LocationSheetWorkflow } from '@/lib/workflows/cf/location-sheet-workflow';
export { LibraryTalentSheetWorkflow } from '@/lib/workflows/cf/library-talent-sheet-workflow';
export { LibraryLocationSheetWorkflow } from '@/lib/workflows/cf/library-location-sheet-workflow';
export { ShotVariantWorkflow } from '@/lib/workflows/cf/shot-variant-workflow';
export { UpscaleShotVariantWorkflow } from '@/lib/workflows/cf/upscale-shot-variant-workflow';
export { VisualPromptSceneWorkflow } from '@/lib/workflows/cf/visual-prompt-scene-workflow';
export { MotionPromptSceneWorkflow } from '@/lib/workflows/cf/motion-prompt-scene-workflow';
export { MusicPromptWorkflow } from '@/lib/workflows/cf/music-prompt-workflow';
export { RecastCharacterWorkflow } from '@/lib/workflows/cf/recast-character-workflow';
export { LocationMatchingWorkflow } from '@/lib/workflows/cf/location-matching-workflow';
export { FrameImagesWorkflow } from '@/lib/workflows/cf/frame-images-workflow';
export { TalentMatchingWorkflow } from '@/lib/workflows/cf/talent-matching-workflow';
export { CharacterBibleWorkflow } from '@/lib/workflows/cf/character-bible-workflow';
export { LocationBibleWorkflow } from '@/lib/workflows/cf/location-bible-workflow';
export { VisualPromptWorkflow } from '@/lib/workflows/cf/visual-prompt-workflow';
export { MotionPromptWorkflow } from '@/lib/workflows/cf/motion-prompt-workflow';
export { MotionMusicPromptsWorkflow } from '@/lib/workflows/cf/motion-music-prompts-workflow';
export { RegenerateFramesWorkflow } from '@/lib/workflows/cf/regenerate-frames-workflow';
export { RecastLocationWorkflow } from '@/lib/workflows/cf/recast-location-workflow';
export { ReplaceElementWorkflow } from '@/lib/workflows/cf/replace-element-workflow';
export { SceneSplitWorkflow } from '@/lib/workflows/cf/scene-split-workflow';
export { StoryboardWorkflow } from '@/lib/workflows/cf/storyboard-workflow';
export { AnalyzeScriptWorkflow } from '@/lib/workflows/cf/analyze-script-workflow';

export default {
  fetch(request: Request) {
    return handler.fetch(request);
  },
};
