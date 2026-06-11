/**
 * Langfuse Prompt Management
 *
 * Two-tier resolution: Langfuse API → local fallback prompts.
 * When Langfuse is not configured, prompts are served from local-prompts.ts.
 */

import { getEnv } from '#env';
import { isLangfusePromptsEnabled } from '@/lib/observability/langfuse';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'prompts', 'index']);

import {
  LangfuseClient,
  type ChatPromptClient,
  type TextPromptClient,
} from '@langfuse/client';
import {
  WORKFLOW_CHAT_PROMPTS,
  WORKFLOW_TEXT_PROMPTS,
} from './workflow-prompts';

let client: LangfuseClient | null = null;

function getClient(): LangfuseClient {
  if (!client) {
    const env = getEnv();
    client = new LangfuseClient({
      publicKey: env.LANGFUSE_PUBLIC_KEY,
      secretKey: env.LANGFUSE_SECRET_KEY,
      baseUrl: env.LANGFUSE_BASE_URL,
    });
  }
  return client;
}

/**
 * Simple {{var}} substitution for local prompt templates.
 */
function compileTemplate(
  template: string,
  variables: Record<string, string>
): string {
  return template.replace(
    /\{\{(\w+)\}\}/g,
    (_, key: string) => variables[key] ?? ''
  );
}

/**
 * Multimodal content part — used for vision-capable chat messages.
 * Mirrors @tanstack/ai's ContentPart shape so messages type-check against
 * the adapter without intermediate conversion.
 * Kept optional so existing string-only prompts stay backwards-compatible.
 */
type ChatMessageTextPart = { type: 'text'; content: string };
export type ChatMessageImagePart = {
  type: 'image';
  source:
    | { type: 'url'; value: string; mimeType?: string }
    | { type: 'data'; value: string; mimeType: string };
};
export type ChatMessageContentPart = ChatMessageTextPart | ChatMessageImagePart;

/**
 * Message format returned by Langfuse chat prompts.
 * `content` is either a plain string (the default for all existing prompts)
 * or an array of content parts for multimodal calls.
 */
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatMessageContentPart[];
};

/**
 * Fetch a text prompt. Tries Langfuse if enabled, falls back to local prompts.
 *
 * @param name - Prompt name (e.g., 'phase/scene-splitting')
 * @param variables - Optional variables to compile into the prompt
 * @returns The prompt reference (for trace linking, undefined when local) and compiled text
 */
export async function getPrompt(
  name: string,
  variables?: Record<string, string>
): Promise<{ prompt: TextPromptClient | undefined; compiled: string }> {
  // Try Langfuse first
  if (isLangfusePromptsEnabled()) {
    try {
      const prompt = await getClient().prompt.get(name, { type: 'text' });
      const compiled = variables ? prompt.compile(variables) : prompt.prompt;
      return { prompt, compiled };
    } catch (error) {
      logger.warn(`Failed to fetch prompt "${name}", falling back to local:`, {
        data: error instanceof Error ? error.message : String(error),
      });
    }
  }

  // Fall back to local prompts
  const localPrompt = WORKFLOW_TEXT_PROMPTS[name];
  if (!localPrompt) {
    throw new Error(
      `Text prompt "${name}" not found in local prompts. Run \`bun scripts/pull-prompts.ts\` to populate.`
    );
  }

  const compiled = variables
    ? compileTemplate(localPrompt, variables)
    : localPrompt;
  return { prompt: undefined, compiled };
}

/**
 * Fetch a chat prompt. Tries Langfuse if enabled, falls back to local prompts.
 *
 * @param name - Prompt name (e.g., 'phase/scene-splitting')
 * @param variables - Variables to compile into the prompt messages
 * @returns The prompt reference (for trace linking, undefined when local) and compiled messages
 */
export async function getChatPrompt(
  name: string,
  variables?: Record<string, string>
): Promise<{
  prompt: ChatPromptClient | undefined;
  messages: ChatMessage[];
}> {
  // Try Langfuse first
  if (isLangfusePromptsEnabled()) {
    try {
      const prompt = await getClient().prompt.get(name, { type: 'chat' });
      const messages = variables ? prompt.compile(variables) : prompt.prompt;
      return { prompt, messages };
    } catch (error) {
      logger.warn(
        `Failed to fetch chat prompt "${name}", falling back to local:`,
        { data: error instanceof Error ? error.message : String(error) }
      );
    }
  }

  // Fall back to local prompts
  const localMessages = WORKFLOW_CHAT_PROMPTS[name];
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- Record<string, T> lookup returns undefined for missing keys
  if (!localMessages) {
    throw new Error(
      `Chat prompt "${name}" not found in local prompts. Run \`bun scripts/pull-prompts.ts\` to populate.`
    );
  }

  const messages: ChatMessage[] = variables
    ? localMessages.map((msg) => ({
        ...msg,
        content:
          typeof msg.content === 'string'
            ? compileTemplate(msg.content, variables)
            : msg.content,
      }))
    : [...localMessages];

  return { prompt: undefined, messages };
}
