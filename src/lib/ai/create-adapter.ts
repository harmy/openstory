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
  const config = {
    httpReferer: env.VITE_APP_URL || 'http://localhost:3000',
    xTitle: env.VITE_APP_NAME || 'OpenStory',
    ...(env.OPENROUTER_BASE_URL && { serverURL: env.OPENROUTER_BASE_URL }),
  };

  return key
    ? createOpenRouterText(adapterModel, key, config)
    : openRouterText(adapterModel, config);
}
