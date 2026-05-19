/**
 * Maps trigger paths (the URL fragment passed to `triggerWorkflow`) to the
 * env binding name declared in `wrangler.jsonc`. Only workflows with a CF
 * port appear here — the rest stay on QStash.
 *
 * To add a new CF-backed workflow:
 *   1. Add the `class_name` + `binding` to `wrangler.jsonc` under `workflows[]`
 *   2. Re-export the entrypoint class from `src/server.ts` so the bundler
 *      includes it.
 *   3. Add an entry here.
 *   4. (Optional) Flip it on by default in `engine-registry.ts`, or canary
 *      via the `CF_WORKFLOWS_ENABLED` env var.
 */

import type { CloudflareEnv, WorkflowEngine } from '@/lib/workflow/cf/types';
import { buildInstanceId } from '@/lib/workflow/cf/instance-id';
import { getEngineForWorkflow } from '@/lib/workflow/cf/engine-registry';

const TRIGGER_TO_BINDING: Record<string, keyof CloudflareEnv> = {
  image: 'IMAGE_WORKFLOW',
  'element-vision': 'ELEMENT_VISION_WORKFLOW',
};

export type CfTriggerResult = { workflowRunId: string };

/**
 * Look up the CF binding for a trigger path. Returns null when the workflow
 * isn't CF-backed.
 */
export function getCfBindingForTriggerPath(
  triggerPath: string,
  env: CloudflareEnv
): Workflow<unknown> | null {
  const key = triggerPath.startsWith('/') ? triggerPath.slice(1) : triggerPath;
  const bindingName = TRIGGER_TO_BINDING[key];
  if (!bindingName) return null;
  const binding = env[bindingName];
  if (!binding || typeof binding !== 'object' || !('create' in binding)) {
    throw new Error(
      `[triggerWorkflow] CF engine selected for '${key}' but env binding '${String(bindingName)}' is missing or not a Workflow binding. ` +
        `Check wrangler.jsonc and ensure 'bun cf:typegen' has been run.`
    );
  }
  return binding;
}

/**
 * Decide which engine to use for a given trigger path. Pure — no side
 * effects, safe to call before doing any work. Bundles the engine choice
 * with the env binding lookup so `triggerWorkflow` only has one place to
 * branch.
 */
export function resolveEngineForTrigger(
  triggerPath: string,
  env: CloudflareEnv
): { engine: WorkflowEngine; binding: Workflow<unknown> | null } {
  const engine = getEngineForWorkflow(triggerPath);
  if (engine !== 'cloudflare') return { engine, binding: null };

  const binding = getCfBindingForTriggerPath(triggerPath, env);
  if (!binding) {
    // Registry says CF but no binding registered — fall back so the system
    // stays available; log loudly so it's obvious in production.
    console.warn(
      `[triggerWorkflow] engine=cloudflare for '${triggerPath}' but no binding map entry found; falling back to qstash`
    );
    return { engine: 'qstash', binding: null };
  }
  return { engine, binding };
}

/**
 * Trigger a CF-backed workflow.
 */
export async function triggerCfWorkflow<T extends Rpc.Serializable<T>>({
  binding,
  triggerPath,
  body,
  env,
  deduplicationId,
}: {
  binding: Workflow<T>;
  triggerPath: string;
  body: T;
  env: CloudflareEnv;
  deduplicationId?: string;
}): Promise<CfTriggerResult> {
  const workflowName = triggerPath.startsWith('/')
    ? triggerPath.slice(1)
    : triggerPath;
  const id = buildInstanceId({
    env,
    workflowName,
    suffix: deduplicationId ?? `${Date.now()}-${crypto.randomUUID()}`,
  });

  const instance = await binding.create({ id, params: body });
  return { workflowRunId: instance.id };
}
