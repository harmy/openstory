import { getEnv } from '#env';
import {
  getCfBindingForTriggerPath,
  triggerCfWorkflow,
} from '@/lib/workflow/trigger-bindings';
import type { CloudflareEnv } from '@/lib/workflow/types';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'client']);

/**
 * Trigger a durable workflow.
 *
 * Every workflow runs on Cloudflare Workflows: this resolves the binding for
 * `urlPath` and calls `binding.create()`. Returns the workflow instance id
 * (persisted as `workflowRunId` on the relevant DB row).
 *
 * `options.deduplicationId` becomes the instance id suffix — pass a stable
 * value to make a trigger idempotent. `label`/`retries`/`retryDelay` are
 * accepted for backwards-compatibility with existing call sites but are no-ops
 * under Cloudflare Workflows (retry policy is configured per `step.do`/on the
 * workflow class; observability comes from the instance id + tail logs).
 */
export async function triggerWorkflow<
  T extends { userId: string; teamId: string },
>(
  urlPath: string,
  body: T,
  options?: {
    deduplicationId?: string;
    label?: string;
    retries?: number;
    retryDelay?: string;
  }
): Promise<string> {
  logger.info('[TriggerWorkflow]', { url: urlPath, body, options });

  const env = getEnv();
  if (env.E2E_TEST === 'true' && env.E2E_FULL_PIPELINE !== 'true') {
    const mockId = options?.deduplicationId ?? `mock-${Date.now()}`;
    logger.info(`Skipping workflow trigger: ${urlPath} (mock ID: ${mockId})`);
    return mockId;
  }

  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- getEnv()'s type is platform-dependent; CF runtime guarantees Cloudflare.Env shape with workflow bindings present
  const cfEnv = env as unknown as CloudflareEnv;
  const binding = getCfBindingForTriggerPath(urlPath, cfEnv);
  const result = await triggerCfWorkflow({
    binding,
    triggerPath: urlPath,
    body,
    env: cfEnv,
    deduplicationId: options?.deduplicationId,
  });
  logger.info('[TriggerWorkflow] Response', { result });
  return result.workflowRunId;
}
