/**
 * Custom TanStack Start server entry.
 *
 * `./instrumentation` is imported first so OpenTelemetry is active before
 * the default handler's transitive route / server-function graph loads.
 */

import './instrumentation';
import handler from '@tanstack/react-start/server-entry';
import {
  acceptsMarkdown,
  getMarkdownForPath,
  markdownResponse,
  withDiscoveryLinkHeader,
  withHtmlAccept,
} from '@/lib/agent/discovery';
import { reconcileAllStuckJobs } from '@/lib/cron/reconcile-all';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'server']);

// Re-export Cloudflare Workflow entrypoint classes so the Worker bundle
// includes them. Each must have a matching entry in `wrangler.jsonc` under
// `workflows[]`. See docs/investigations/cloudflare-workflows-poc.md.
export { ImageWorkflow } from '@/lib/workflows/image-workflow';
export { ElementVisionWorkflow } from '@/lib/workflows/element-vision-workflow';
export { ElementSheetWorkflow } from '@/lib/workflows/element-sheet-workflow';
export { MusicWorkflow } from '@/lib/workflows/music-workflow';
export { MotionWorkflow } from '@/lib/workflows/motion-workflow';
export { MotionBatchWorkflow } from '@/lib/workflows/motion-batch-workflow';
export { CharacterSheetWorkflow } from '@/lib/workflows/character-sheet-workflow';
export { LocationSheetWorkflow } from '@/lib/workflows/location-sheet-workflow';
export { LibraryTalentSheetWorkflow } from '@/lib/workflows/library-talent-sheet-workflow';
export { LibraryLocationSheetWorkflow } from '@/lib/workflows/library-location-sheet-workflow';
export { ShotVariantWorkflow } from '@/lib/workflows/shot-variant-workflow';
export { UpscaleShotVariantWorkflow } from '@/lib/workflows/upscale-shot-variant-workflow';
export { VisualPromptSceneWorkflow } from '@/lib/workflows/visual-prompt-scene-workflow';
export { MotionPromptSceneWorkflow } from '@/lib/workflows/motion-prompt-scene-workflow';
export { MusicPromptWorkflow } from '@/lib/workflows/music-prompt-workflow';
export { RecastCharacterWorkflow } from '@/lib/workflows/recast-character-workflow';
export { LocationMatchingWorkflow } from '@/lib/workflows/location-matching-workflow';
export { FrameImagesWorkflow } from '@/lib/workflows/frame-images-workflow';
export { TalentMatchingWorkflow } from '@/lib/workflows/talent-matching-workflow';
export { CharacterBibleWorkflow } from '@/lib/workflows/character-bible-workflow';
export { LocationBibleWorkflow } from '@/lib/workflows/location-bible-workflow';
export { VisualPromptWorkflow } from '@/lib/workflows/visual-prompt-workflow';
export { MotionPromptWorkflow } from '@/lib/workflows/motion-prompt-workflow';
export { MotionMusicPromptsWorkflow } from '@/lib/workflows/motion-music-prompts-workflow';
export { RegenerateFramesWorkflow } from '@/lib/workflows/regenerate-frames-workflow';
export { RecastLocationWorkflow } from '@/lib/workflows/recast-location-workflow';
export { ReplaceElementWorkflow } from '@/lib/workflows/replace-element-workflow';
export { SceneSplitWorkflow } from '@/lib/workflows/scene-split-workflow';
export { StoryboardWorkflow } from '@/lib/workflows/storyboard-workflow';
export { AnalyzeScriptWorkflow } from '@/lib/workflows/analyze-script-workflow';

// Realtime broker Durable Object. Re-exported so the binding's `class_name`
// in wrangler.jsonc resolves in the Worker bundle (#802).
export { RealtimeChannel } from '@/lib/realtime/realtime-channel.do';

// Bindings shape from wrangler.jsonc. Only declared so the scheduled() handler
// has a real type for its env parameter (vs. the framework default of unknown).
interface WorkerEnv {
  DB: D1Database;
  R2_PUBLIC_ASSETS_BUCKET: R2Bucket;
  R2_STORAGE_BUCKET: R2Bucket;
  REALTIME: DurableObjectNamespace;
}

const exportedHandler: ExportedHandler<WorkerEnv> = {
  async fetch(request) {
    const { pathname } = new URL(request.url);

    // Markdown content negotiation for agents (#819): serve a real markdown
    // rendition where one exists; otherwise fall back to HTML rather than
    // letting the router 500 on a non-HTML Accept header.
    const wantsMarkdown = acceptsMarkdown(request);
    if (wantsMarkdown) {
      const markdown = getMarkdownForPath(pathname);
      if (markdown !== null) return markdownResponse(markdown, request.method);
    }

    const response = await handler.fetch(
      wantsMarkdown ? withHtmlAccept(request) : request
    );
    // RFC 8288 Link headers on document responses for agent discovery.
    return withDiscoveryLinkHeader(response, pathname);
  },
  scheduled(_controller, _env, ctx) {
    // Best-effort sweep for stuck generating-status rows across every table.
    // See src/lib/cron/reconcile-all.ts; cron schedule is in wrangler.jsonc.
    ctx.waitUntil(
      reconcileAllStuckJobs().catch((error) => {
        logger.error('reconcileAllStuckJobs failed:', { err: error });
      })
    );
  },
};

export default exportedHandler;
