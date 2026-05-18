/**
 * Element Vision Workflow
 *
 * Calls a vision LLM to produce a visual description + consistency tag for
 * a single uploaded sequence element.
 */

import { describeElementImage } from '@/lib/ai/element-vision';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  ElementVisionWorkflowInput,
  ElementVisionWorkflowResult,
} from '@/lib/workflow/types';

export const elementVisionWorkflow = createScopedWorkflow<
  ElementVisionWorkflowInput,
  ElementVisionWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const { elementId, imageUrl, filename } = input;

    // Step 1: mark analyzing
    await context.run('mark-analyzing', async () => {
      await scopedDb.sequenceElements.updateVisionStatus(
        elementId,
        'analyzing'
      );
    });

    // Step 2: load element so we know the current token (for auto-rename).
    const element = await context.run('load-element', async () => {
      const el = await scopedDb.sequenceElements.getById(elementId);
      if (!el) throw new Error(`Element ${elementId} not found`);
      return el;
    });

    // Step 3: vision call (also returns a vision-suggested token).
    const { description, consistencyTag, suggestedToken } = await context.run(
      'describe-element',
      async () => {
        const openRouterApiKeyInfo =
          await scopedDb.apiKeys.resolveKey('openrouter');
        return await describeElementImage({
          imageUrl,
          filename,
          openRouterApiKey: openRouterApiKeyInfo.key,
        });
      }
    );

    // Step 4: persist description + consistencyTag.
    await context.run('persist-vision', async () => {
      await scopedDb.sequenceElements.updateVisionResult(
        elementId,
        description,
        consistencyTag
      );
    });

    // Step 5: auto-rename to vision-suggested token if different. Uses
    // ensureUniqueToken (suffixes `_2` on collision) because the system is
    // choosing the name — failing the workflow on collision would strand the
    // element with no usable name.
    const finalToken = await context.run('auto-rename', async () => {
      if (suggestedToken === element.token) return element.token;
      const unique = await scopedDb.sequenceElements.ensureUniqueToken(
        element.sequenceId,
        suggestedToken
      );
      if (unique === element.token) return element.token;
      const result = await scopedDb.sequenceElements.cascadeRename({
        sequenceId: element.sequenceId,
        elementId,
        oldToken: element.token,
        newToken: unique,
      });
      return result.element.token;
    });

    return {
      elementId,
      description,
      consistencyTag,
      token: finalToken,
    };
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const { elementId } = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);
      console.error('[ElementVisionWorkflow] Failed:', error);
      try {
        await scopedDb.sequenceElements.updateVisionStatus(
          elementId,
          'failed',
          error
        );
      } catch (e) {
        console.error('[ElementVisionWorkflow] Failed to persist error:', e);
      }
      return `Element vision failed: ${error}`;
    },
  }
);
