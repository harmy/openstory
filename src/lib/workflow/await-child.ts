/**
 * Sub-workflow await helper (Pattern 3 from the investigation).
 *
 * CF Workflows has no `context.invoke()`-equivalent that returns the child's
 * value. This helper composes the documented primitives — `BINDING.create()`,
 * `step.waitForEvent`, and `WorkflowInstance.sendEvent` — into the same
 * "spawn child, await result" shape we get from QStash.
 *
 * Parent side:
 *
 *   const childOutput = await spawnAndAwaitChild(step, {
 *     binding: env.IMAGE_WORKFLOW,
 *     parentBinding: env.STORYBOARD_WORKFLOW,
 *     parentInstanceId: event.instanceId,
 *     childId: 'image:seq-123:frame-7',
 *     childPayload: { ...input, _parent: { ... } },
 *     name: 'spawn-image-7',
 *     timeout: '30 minutes',
 *   });
 *
 * Child side — last step before the workflow returns:
 *
 *   await notifyParent(step, env, event.payload._parent, output);
 *
 * The child's `_parent` slot carries the parent's binding name, instance id,
 * and event type so the leaf workflow doesn't need to know who its caller is.
 *
 * See docs/investigations/cloudflare-workflows.md §4 Gap A.
 */

import type { CloudflareEnv } from '@/lib/workflow/types';
import type { WorkflowSleepDuration, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'cf', 'await-child']);

const DEFAULT_TIMEOUT: WorkflowSleepDuration = '30 minutes';

/**
 * Cloudflare Workflows enforces `^[a-zA-Z0-9_-]+$` on instance IDs. Callers
 * typically pass semantic ids like `image:seq-123:frame-7` with colons —
 * normalise to underscores so `binding.create({ id })` doesn't throw
 * "Workflow instance has invalid id". Truncate to 100 chars (CF limit).
 */
function sanitizeChildId(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 100);
}

/**
 * Slot the parent injects into the child's payload so the child knows who
 * to notify. Payload size cost: ~150 bytes.
 */
export type ParentNotifyHint = {
  /** Binding name on `env` (uppercase, matches wrangler.jsonc). */
  bindingName: keyof CloudflareEnv;
  parentInstanceId: string;
  /** Unique event type for this spawn — `${childWorkflowName}-done:${childId}`. */
  eventType: string;
};

export type ChildOutcome<TOutput> =
  | { status: 'ok'; output: TOutput }
  | { status: 'failed'; error: string };

type SpawnAndAwaitArgs<TInput> = {
  binding: Workflow<TInput & { _parent: ParentNotifyHint }>;
  parentBindingName: keyof CloudflareEnv;
  parentInstanceId: string;
  childId: string;
  childPayload: TInput;
  /** Step name for the spawn `step.do`. */
  spawnStepName: string;
  /** Step name for the `step.waitForEvent`. */
  awaitStepName: string;
  /** Defaults to 30 minutes — long enough for the slowest leaf (motion). */
  timeout?: WorkflowSleepDuration;
};

/**
 * Spawn a child workflow and block until it `sendEvent`s back with its
 * output (or until the timeout expires). The child must call
 * {@link notifyParent} as its last step.
 *
 * Returns the child's typed output. Throws if the child never sends the
 * event (timeout) — the caller should wrap in try/catch if a timed-out
 * child should not fail the parent.
 */
export async function spawnAndAwaitChild<TInput, TOutput>(
  step: WorkflowStep,
  args: SpawnAndAwaitArgs<TInput>
): Promise<TOutput> {
  const childId = sanitizeChildId(args.childId);
  const eventType = buildEventType(args.binding, childId);

  await step.do(args.spawnStepName, async () => {
    await args.binding.create({
      id: childId,
      params: {
        ...args.childPayload,
        _parent: {
          bindingName: args.parentBindingName,
          parentInstanceId: args.parentInstanceId,
          eventType,
        },
      },
    });
    return { childId, eventType };
  });

  // step.waitForEvent's generic is constrained to Rpc.Serializable, but
  // `TOutput` is whatever the child workflow returns — by construction that's
  // serializable JSON (workflow results are persisted by CF either way), so
  // we widen to `unknown` at the call site and narrow back via the discriminant.
  const event = await step.waitForEvent<{ status: 'ok' | 'failed' }>(
    args.awaitStepName,
    {
      type: eventType,
      timeout: args.timeout ?? DEFAULT_TIMEOUT,
    }
  );
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- payload shape is enforced by notifyParent / notifyParentOfFailure which are the only senders for this event type
  const outcome = event.payload as ChildOutcome<TOutput>;

  if (outcome.status === 'failed') {
    throw new Error(`Child workflow ${args.childId} failed: ${outcome.error}`);
  }
  return outcome.output;
}

/**
 * Send the child's output back to the parent. Call this as the child's
 * last step. The base class wraps `runImpl` failures and routes them
 * through `notifyParentOfFailure` automatically.
 */
export async function notifyParent<TOutput>(
  step: WorkflowStep,
  env: CloudflareEnv,
  hint: ParentNotifyHint | undefined,
  output: TOutput
): Promise<void> {
  if (!hint) return;
  await step.do('notify-parent', async () => {
    const parent = await resolveParentInstance(env, hint);
    await parent.sendEvent({
      type: hint.eventType,
      payload: { status: 'ok', output } satisfies ChildOutcome<TOutput>,
    });
  });
}

/**
 * Notify the parent that this child failed. Called from the base class's
 * failure wrapper — does not throw on its own (cleanup must not mask the
 * original error).
 */
export async function notifyParentOfFailure(
  env: CloudflareEnv,
  hint: ParentNotifyHint | undefined,
  error: string
): Promise<void> {
  if (!hint) return;
  try {
    const parent = await resolveParentInstance(env, hint);
    await parent.sendEvent({
      type: hint.eventType,
      payload: { status: 'failed', error } satisfies ChildOutcome<never>,
    });
  } catch (notifyError) {
    logger.error(
      `[notifyParentOfFailure] could not deliver failure event to ${hint.parentInstanceId}:`,
      {
        err: notifyError,
      }
    );
  }
}

async function resolveParentInstance(
  env: CloudflareEnv,
  hint: ParentNotifyHint
): Promise<WorkflowInstance> {
  const binding = env[hint.bindingName];
  if (!isWorkflowBinding(binding)) {
    throw new Error(
      `Parent binding '${String(hint.bindingName)}' is not a Workflow binding on env`
    );
  }
  return binding.get(hint.parentInstanceId);
}

function isWorkflowBinding(value: unknown): value is Workflow<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    'create' in value &&
    'get' in value
  );
}

/**
 * Build the unique event type for a parent→child wait. Including the child
 * ID guarantees two siblings (e.g. fan-out over N scenes) get distinct
 * events and the parent's `waitForEvent` cannot match the wrong sibling.
 */
function buildEventType(binding: Workflow<unknown>, childId: string): string {
  // The binding has no name accessor; we use the constructor name as a
  // best-effort qualifier and rely on `childId` for uniqueness.
  const qualifier = binding.constructor.name || 'workflow';
  const candidate = `${qualifier}-done:${childId}`;
  // CF event type names are capped at 100 chars.
  return candidate.length > 100 ? candidate.slice(0, 100) : candidate;
}
