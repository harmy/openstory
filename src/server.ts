/**
 * Custom TanStack Start server entry.
 *
 * `./instrumentation` is imported first so OpenTelemetry is active before
 * the default handler's transitive route / server-function graph loads.
 */

import './instrumentation';
import handler from '@tanstack/react-start/server-entry';
import { reconcileAllStuckJobs } from '@/lib/cron/reconcile-all';

// Bindings shape from wrangler.jsonc. Only declared so the scheduled() handler
// has a real type for its env parameter (vs. the framework default of unknown).
interface WorkerEnv {
  DB: D1Database;
  R2_PUBLIC_ASSETS_BUCKET: R2Bucket;
  R2_STORAGE_BUCKET: R2Bucket;
}

const exportedHandler: ExportedHandler<WorkerEnv> = {
  fetch(request) {
    return handler.fetch(request);
  },
  scheduled(_controller, _env, ctx) {
    // Best-effort sweep for stuck generating-status rows across every table.
    // See src/lib/cron/reconcile-all.ts; cron schedule is in wrangler.jsonc.
    ctx.waitUntil(
      reconcileAllStuckJobs().catch((error) => {
        console.error('[scheduled] reconcileAllStuckJobs failed:', error);
      })
    );
  },
};

export default exportedHandler;
