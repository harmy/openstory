/**
 * Base class for Cloudflare Workflows entrypoints.
 *
 * Wraps `run()` with a sanitized failure handler that mirrors the QStash
 * `failureFunction` contract — when the workflow body throws, the wrapper
 * extracts a friendly message, calls a subclass-supplied `onFailure` (typed),
 * and rethrows so CF marks the instance as `errored`.
 *
 * Subclasses implement `runImpl(event, step, scopedDb)` and optionally
 * `onFailure({ event, error, scopedDb })`. The base class:
 *   - Validates `userId` / `teamId` on the payload (same contract as
 *     `createScopedWorkflow`'s teamId middleware).
 *   - Builds a `ScopedDb` from the payload and hands it to both `runImpl`
 *     and `onFailure`.
 *   - Sanitizes the error message and emits it in a `step.do('emit-failure')`
 *     so the failure write itself benefits from retries + step durability.
 *
 * See docs/investigations/cloudflare-workflows.md §4 Gap D.
 */

import { configureFalProxyFromEnv } from '@/lib/ai/fal-config';
import { createScopedDb, type ScopedDb } from '@/lib/db/scoped';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import type { UserWorkflowContext } from '@/lib/workflow/types';
import {
  notifyParent,
  notifyParentOfFailure,
  type ParentNotifyHint,
} from '@/lib/workflow/await-child';
import type { CloudflareEnv } from '@/lib/workflow/types';
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'cf', 'base']);

/**
 * Read the `_parent` notify hint a parent workflow injects via
 * `spawnAndAwaitChild`. The runtime payload may carry the slot even though
 * the typed `T` doesn't include it (Pattern 3 injects it as an addition).
 */
function extractParentHint(payload: unknown): ParentNotifyHint | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- runtime-injected slot not part of the typed payload shape
  const hint = (payload as { _parent?: ParentNotifyHint })._parent;
  if (!hint) return undefined;
  if (
    typeof hint.bindingName === 'string' &&
    typeof hint.parentInstanceId === 'string' &&
    typeof hint.eventType === 'string'
  ) {
    return hint;
  }
  return undefined;
}

export type OpenStoryFailureContext<T extends UserWorkflowContext> = {
  event: Readonly<WorkflowEvent<T>>;
  error: string;
  scopedDb: ScopedDb;
};

export abstract class OpenStoryWorkflowEntrypoint<
  T extends UserWorkflowContext,
> extends WorkflowEntrypoint<CloudflareEnv, T> {
  /**
   * Subclasses implement workflow logic here. Receives the same `event` /
   * `step` the engine hands to `run()`, plus a `ScopedDb` bound to the
   * payload's `(teamId, userId)`.
   */
  protected abstract runImpl(
    event: Readonly<WorkflowEvent<T>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<unknown>;

  /**
   * Optional failure hook. Runs inside a `step.do('emit-failure')` so the
   * cleanup write itself is retried by the engine. The original error is
   * rethrown after this returns — the workflow ends in `errored` state.
   */
  protected onFailure?(
    failure: OpenStoryFailureContext<T>
  ): Promise<void> | void;

  override async run(
    event: Readonly<WorkflowEvent<T>>,
    step: WorkflowStep
  ): Promise<unknown> {
    if (!event.payload.teamId || !event.payload.userId) {
      throw new Error(
        `[${this.constructor.name}] payload missing teamId or userId — every workflow extending OpenStoryWorkflowEntrypoint must include both`
      );
    }

    const scopedDb = createScopedDb(event.payload.teamId, event.payload.userId);

    // Install the fal→proxy middleware on the global `fal` singleton before any
    // step runs a fal adapter. In E2E this routes fal.run / queue.fal.run to the
    // aimock proxy (FAL_PROXY_URL); in prod it's a no-op (FAL_PROXY_URL unset).
    // The QStash-era base-workflow did this at the top of run(); the CF Workflows
    // rewrite (a8011203) dropped it, so workflow fal calls bypassed aimock and
    // hit real endpoints even in replay. Idempotent (module-flag guarded), so
    // running it per workflow invocation / retry is safe. See lib/ai/fal-config.
    configureFalProxyFromEnv();

    // Pull the parent notify hint once — used on both success and failure
    // paths so a parent's `spawnAndAwaitChild` always sees a terminal event.
    const parentHint = extractParentHint(event.payload);

    try {
      const result = await this.runImpl(event, step, scopedDb);

      // Notify the parent on success (Pattern 3 fan-in). No-op for top-level
      // workflows that weren't spawned via spawnAndAwaitChild.
      if (parentHint) {
        await notifyParent(step, this.env, parentHint, result);
      }
      return result;
    } catch (error) {
      const sanitized = sanitizeFailResponse(error);
      // Sanitized message inline in the headline; `err` carries the full
      // original error (with stack) as a structured property.
      logger.error(`[${this.constructor.name}] Failure: ${sanitized}`, {
        err: error,
      });

      if (this.onFailure) {
        // Wrap in step.do so cleanup retries on its own merits and doesn't
        // mask the original throw — if the cleanup fails after its own
        // retries, both errors surface in the instance status.
        await step.do('emit-failure', async () => {
          try {
            await this.onFailure?.({ event, error: sanitized, scopedDb });
          } catch (cleanupError) {
            logger.error(
              `[${this.constructor.name}] onFailure handler itself failed:`,
              {
                err: cleanupError,
              }
            );
            // Swallow the cleanup error — the original error is what we
            // want to surface as the instance's terminal state.
          }
        });
      }

      // Notify the parent on failure too — otherwise a parent's
      // `step.waitForEvent` would hang until its timeout. The send is durable
      // (retried inside its own step.do); if delivery is still impossible after
      // retries we swallow here so it can't mask the original error.
      if (parentHint) {
        try {
          await notifyParentOfFailure(step, this.env, parentHint, sanitized);
        } catch (notifyError) {
          logger.error(
            `[${this.constructor.name}] failure notification to parent exhausted retries`,
            { err: notifyError }
          );
        }
      }

      // `WorkflowValidationError` is a plain Error subclass, which CF treats as
      // retryable — so without this re-wrap CF would retry validation throws up
      // to the step's retry limit (10× by default). Re-throw as CF's
      // `NonRetryableError` so the instance fails immediately.
      if (error instanceof WorkflowValidationError) {
        throw new NonRetryableError(sanitized, error.name);
      }
      throw error;
    }
  }
}
