/**
 * Shared OpenRouter adapter factory
 * Creates TanStack AI adapters for OpenRouter models
 */

import { getEnv } from '#env';
import type { TextModel } from '@/lib/ai/models';
import { createOpenRouterText, openRouterText } from '@tanstack/ai-openrouter';

export function createAdapter(model: TextModel, apiKey?: string) {
  const env = getEnv();
  const key = apiKey ?? env.OPENROUTER_KEY;
  // Adapter type list lags behind OpenRouter's catalog — cast at the boundary
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Model is dynamic from config but always a valid OpenRouter model ID
  const adapterModel = model as Parameters<typeof openRouterText>[0];

  // During E2E recording, aimock proxies our OpenRouter calls upstream and
  // *buffers* the entire SSE response before relaying — see
  // node_modules/@copilotkit/aimock/dist/recorder.js. That buffering window
  // can trip the SDK's default backoff retry, producing two upstream calls
  // and two fixture files for the same prompt. Disable retry and stretch
  // the per-request timeout so the single proxied call has time to land.
  // QStash retries failed steps at the workflow layer, so this doesn't
  // remove all retry coverage — only the SDK-internal retry that fights
  // with aimock's buffering during record.
  const isRecording = env.E2E_RECORD === '1';

  const config = {
    httpReferer: env.VITE_APP_URL || 'http://localhost:3000',
    xTitle: env.VITE_APP_NAME || 'OpenStory',
    ...(env.OPENROUTER_BASE_URL && { serverURL: env.OPENROUTER_BASE_URL }),
    ...(isRecording && {
      retryConfig: { strategy: 'none' as const },
      timeoutMs: 600_000,
    }),
  };

  return key
    ? createOpenRouterText(adapterModel, key, config)
    : openRouterText(adapterModel, config);
}
