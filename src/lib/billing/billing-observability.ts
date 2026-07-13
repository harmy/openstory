/**
 * Observability for billing gaps — when a completed AI call reports no cost.
 */

import { getPostHogClient } from '@/lib/posthog-server';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'billing', 'missing-cost']);

export type MissingBillingCostContext = {
  source: string;
  modelId?: string;
  workflowName?: string;
  description?: string;
  teamId?: string;
  metadata?: Record<string, unknown>;
};

/** Log and emit analytics when a completed generation has nothing to bill. */
export function reportMissingBillingCost(ctx: MissingBillingCostContext): void {
  logger.warn('Completed AI generation with no billable cost reported', ctx);

  const posthog = getPostHogClient();
  posthog?.capture({
    distinctId: ctx.teamId ?? 'system',
    event: 'billing_missing_cost',
    properties: {
      source: ctx.source,
      model_id: ctx.modelId,
      workflow_name: ctx.workflowName,
      description: ctx.description,
      ...ctx.metadata,
    },
  });
}
