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

export default {
  fetch(request: Request) {
    return handler.fetch(request);
  },
};
