import { getEnv } from '#env';
import { ConfigurationError } from '@/lib/errors';
import { getServerAppUrl } from '@/lib/utils/environment';
import { getRequest } from '@tanstack/react-start/server';
import { Client as QStashClient, type FlowControl } from '@upstash/qstash';
import { Client as WorkflowClient } from '@upstash/workflow';

function getVercelBypassHeaders(): Record<string, string> | undefined {
  const secret = getEnv().VERCEL_AUTOMATION_BYPASS_SECRET;
  if (!secret) return undefined;

  return {
    'Upstash-Forward-X-Vercel-Protection-Bypass': secret,
    'X-Vercel-Protection-Bypass': secret,
    'upstash-callback-forward-X-Vercel-Protection-Bypass': secret,
    'upstash-failure-callback-forward-X-Vercel-Protection-Bypass': secret,
  };
}

function requireQStashToken(): string {
  const token = getEnv().QSTASH_TOKEN;
  if (!token)
    throw new ConfigurationError(
      'QStash is not configured. Run `bun setup` and enable workflows, or start the emulator with `bun qstash:dev`.'
    );
  return token;
}

/** QStash client for serve() handler signature verification */
export function getQStashClient(): QStashClient {
  return new QStashClient({
    token: requireQStashToken(),
    headers: getVercelBypassHeaders(),
  });
}

/**
 * Resolve the webhook URL QStash will call back to.
 * In local dev, rewrites localhost to host.docker.internal so
 * the QStash Docker container can reach the app.
 */
function getQStashWebhookUrl(request: Request): string {
  const serverAppUrl = getServerAppUrl(request);
  const url = new URL(serverAppUrl);

  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    url.protocol = 'http:';
    url.hostname = 'host.docker.internal';
    return url.origin;
  }

  return serverAppUrl;
}

/** WorkflowClient for checking workflow run status (e.g. reconciliation) */
export function getWorkflowClient(): WorkflowClient {
  return new WorkflowClient({
    token: requireQStashToken(),
    headers: getVercelBypassHeaders(),
  });
}

export async function triggerWorkflow<
  T extends { userId: string; teamId: string },
>(
  urlPath: string,
  body: T,
  options?: {
    deduplicationId?: string;
    label?: string;
    flowControl?: FlowControl;
    retries?: number;
    retryDelay?: string;
  }
): Promise<string> {
  console.log('[TriggerWorkflow]', { url: urlPath, body, options });

  const env = getEnv();
  if (env.E2E_TEST === 'true' && env.E2E_FULL_PIPELINE !== 'true') {
    const mockId = options?.deduplicationId ?? `mock-${Date.now()}`;
    console.log(
      `[E2E] Skipping workflow trigger: ${urlPath} (mock ID: ${mockId})`
    );
    return mockId;
  }

  const client = new WorkflowClient({
    token: requireQStashToken(),
    headers: getVercelBypassHeaders(),
  });
  const baseUrl = `${getQStashWebhookUrl(getRequest())}/api/workflows`;

  const response = await client.trigger({
    url: `${baseUrl}${urlPath}`,
    body,
    workflowRunId: options?.deduplicationId,
    headers: getVercelBypassHeaders(),
    label: options?.label,
    flowControl: options?.flowControl,
    retries: options?.retries,
    retryDelay: options?.retryDelay,
  });

  console.log('[TriggerWorkflow] Response:', response);
  return response.workflowRunId;
}
