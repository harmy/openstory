/**
 * Scoped Workflow Factory
 * The ONLY workflow-side file that imports createScopedDb.
 * All workflows use createScopedWorkflow instead of createWorkflow directly.
 */

import { createScopedDb, type ScopedDb } from '@/lib/db/scoped';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type { UserWorkflowContext } from '@/lib/workflow/types';
import type { WorkflowContext } from '@upstash/workflow';
import { WorkflowMiddleware } from '@upstash/workflow';
import { createWorkflow } from '@upstash/workflow/tanstack';

export type ScopedWorkflowFailureData<T extends UserWorkflowContext> = {
  context: Omit<
    WorkflowContext<T>,
    | 'run'
    | 'sleepUntil'
    | 'sleep'
    | 'call'
    | 'waitForEvent'
    | 'notify'
    | 'cancel'
    | 'api'
    | 'invoke'
    | 'createWebhook'
    | 'waitForWebhook'
  >;
  scopedDb: ScopedDb;
  failResponse: string;
  failStatus: number;
  failHeaders: Record<string, string[]>;
  failStack: string;
};

export function createScopedWorkflow<
  T extends UserWorkflowContext,
  TResult = unknown,
>(
  fn: (context: WorkflowContext<T>, scopedDb: ScopedDb) => Promise<TResult>,
  options?: {
    failureFunction?: (
      params: ScopedWorkflowFailureData<T>
    ) => Promise<void | string> | void | string;
  }
) {
  const teamIdValidation = new WorkflowMiddleware<T, TResult>({
    name: 'teamId-validation',
    callbacks: {
      runStarted: async ({ context }) => {
        if (!context.requestPayload.teamId) {
          throw new WorkflowValidationError('teamId is required');
        }
      },
    },
  });

  return createWorkflow<T, TResult>(
    async (context) => {
      const scopedDb = createScopedDb(
        context.requestPayload.teamId,
        context.requestPayload.userId
      );
      return fn(context, scopedDb);
    },
    {
      middlewares: [teamIdValidation],
      failureFunction: options?.failureFunction
        ? async (failData) => {
            const scopedDb = createScopedDb(
              failData.context.requestPayload.teamId,
              failData.context.requestPayload.userId
            );
            const failureFn = options.failureFunction;
            if (failureFn) return failureFn({ ...failData, scopedDb });
          }
        : undefined,
    }
  );
}
