import { getEnv } from '#env';
import type { FlowControl } from '@upstash/qstash';

/**
 * Shared flow control configuration for Fal.ai requests.
 * Ensures we respect concurrency limits and rate limits across all AI workflows.
 */
export const getFalFlowControl = (): FlowControl => {
  const env = getEnv();
  const concurrencyLimit = env.FAL_CONCURRENCY_LIMIT
    ? parseInt(env.FAL_CONCURRENCY_LIMIT)
    : 20;

  return {
    key: 'fal-requests-2',
    parallelism: concurrencyLimit,
  };
};

/**
 * Shared flow control configuration for LLM requests (OpenRouter).
 * Prevents thundering herd when dispatching many parallel scene workflows.
 */
export const getLLMFlowControl = (): FlowControl => {
  const env = getEnv();
  const concurrencyLimit = env.LLM_CONCURRENCY_LIMIT
    ? parseInt(env.LLM_CONCURRENCY_LIMIT)
    : 50;

  return {
    key: 'llm-requests',
    parallelism: concurrencyLimit,
  };
};
