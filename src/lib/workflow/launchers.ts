/**
 * Centralised top-level workflow launchers.
 *
 * Every non-child workflow start belongs here as a named launcher function
 * that owns the trigger AND its side effects — deduplication id, persisting
 * the run id, status writes, and cross-cutting policy like the generation
 * mutex. Feature code calls `triggerStoryboard(...)`, never a bare
 * `triggerWorkflow('/storyboard', ...)`: duplicated side-effect logic at
 * call sites is how the four storyboard triggers drifted apart before #839.
 *
 * Today only the storyboard launcher lives here; the remaining ~30
 * `triggerWorkflow` call sites migrate incrementally, after which imports of
 * `@/lib/workflow/client` get lint-restricted to this file.
 *
 * ## The storyboard generation mutex (#839)
 *
 * CF Workflows has no "singleton instance" mode — instance ids are unique
 * FOREVER (a completed instance blocks its id for the 30-day retention
 * window), so a stable `storyboard-<sequenceId>` id would block legitimate
 * retries, not just concurrent ones. Instead `sequences.workflow_run_id`
 * doubles as a lock:
 *
 *   1. Read the column; if it points at a live instance, reject.
 *   2. Claim it with a compare-and-swap (`scopedDb.sequences
 *      .claimWorkflowSlot`) — exactly one of two racing requests wins, even
 *      when both passed step 1.
 *   3. Trigger with the claim id as `deduplicationId`, then overwrite the
 *      column with the real instance id. If the trigger crashes in between,
 *      the stranded claim resolves as 'failed' on the next acquire (it
 *      matches no workflow binding), so the slot recovers — never wedges.
 *
 * Termination-order caveat: a terminal storyboard does NOT imply its
 * descendants are dead (children outlive a timed-out parent — see #839).
 * This mutex guards the storyboard ROOT only; cooperative descendant
 * cancellation (rootRunId staleness check + user-facing cancel) is tracked
 * separately.
 */

import { generateId } from '@/lib/db/id';
import type { ScopedDb } from '@/lib/db/scoped';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { resolveRunState } from '@/lib/workflow/reconcile';
import type { StoryboardWorkflowInput } from '@/lib/workflow/types';

/** Thrown when a storyboard run is already in flight for the sequence. */
export class GenerationInProgressError extends Error {
  constructor() {
    super(
      'A generation is already running for this sequence — wait for it to finish before retrying.'
    );
    this.name = 'GenerationInProgressError';
  }
}

/**
 * Thrown when the run-status lookup itself failed, so we can't tell whether
 * a generation is live. Distinct from `GenerationInProgressError` — telling
 * the user to "wait for it to finish" would be wrong when there may be no
 * run at all (a CF status-API blip), and waiting would never clear it.
 */
export class GenerationStatusUnknownError extends Error {
  constructor() {
    super(
      "Couldn't verify whether a generation is still running — please try again in a moment."
    );
    this.name = 'GenerationStatusUnknownError';
  }
}

/**
 * Mutex step 1 — fetch the sequence and reject unless its most recent
 * storyboard run can be ruled out as live:
 *   - in flight (queued/running/paused/waiting) → `GenerationInProgressError`
 *   - status lookup failed → `GenerationStatusUnknownError`
 *
 * Both fail closed — the right direction for a mutex — but with messages
 * that match what we actually know.
 */
async function getSequenceRejectingActiveRun(
  scopedDb: ScopedDb,
  sequenceId: string
) {
  const sequence = await scopedDb.sequences.getForUser({ sequenceId });
  if (!sequence.workflowRunId) return sequence; // legacy row or never generated
  const state = await resolveRunState(sequence.workflowRunId);
  if (state === null) throw new GenerationInProgressError();
  if (state === 'unknown') throw new GenerationStatusUnknownError();
  return sequence;
}

/**
 * Throw if the sequence's most recent storyboard run is still in flight
 * (or its status can't be verified — see `getSequenceRejectingActiveRun`).
 *
 * Check-only — for partial retries (per-shot image/motion) that must not
 * race a live full pipeline but don't start a storyboard themselves.
 */
export async function assertNoActiveStoryboard(
  scopedDb: ScopedDb,
  sequenceId: string
): Promise<void> {
  await getSequenceRejectingActiveRun(scopedDb, sequenceId);
}

/**
 * Start a storyboard run for a sequence: acquire the generation mutex,
 * mark the sequence 'processing' (clearing any prior error), trigger the
 * workflow, and persist the instance id for the reconciler and future
 * mutex checks. The single entry point for `/storyboard` — all call sites
 * (create, retry, regenerate, smart-retry fallback) go through here.
 */
export async function triggerStoryboard(
  scopedDb: ScopedDb,
  input: StoryboardWorkflowInput
): Promise<{ workflowRunId: string }> {
  const { sequenceId } = input;
  if (!sequenceId) {
    throw new Error('triggerStoryboard requires input.sequenceId');
  }

  // Mutex step 1: reject while the previous run is still in flight (or its
  // state can't be verified).
  const sequence = await getSequenceRejectingActiveRun(scopedDb, sequenceId);

  // Mutex step 2: CAS-claim the slot so two racing requests can't both pass.
  const claimId = `storyboard-${sequenceId}-${generateId()}`;
  const claimed = await scopedDb.sequences.claimWorkflowSlot({
    id: sequenceId,
    expectedRunId: sequence.workflowRunId,
    claimId,
  });
  if (!claimed) throw new GenerationInProgressError();

  // Eager status write so the UI flips immediately; the workflow's first
  // step re-asserts 'processing' either way. Clears any prior statusError.
  await scopedDb.sequence(sequenceId).updateStatus('processing');

  // Mutex step 3: the claim id IS the deduplication id — if this call
  // crashes after create() but the caller retries the whole launcher, the
  // fresh claim produces a fresh instance; a stranded claim resolves as
  // 'failed' on the next acquire and the slot recovers.
  const workflowRunId = await triggerWorkflow('/storyboard', input, {
    deduplicationId: claimId,
    label: buildWorkflowLabel(sequenceId),
  });
  await scopedDb.sequences.update({ id: sequenceId, workflowRunId });

  return { workflowRunId };
}
