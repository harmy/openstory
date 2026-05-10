import { getEnv } from '#env';
import { getSignedUploadUrl } from '#storage';
import { describeElementImage } from '@/lib/ai/element-vision';
import { generateId } from '@/lib/db/id';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { deriveTokenFromFilename } from '@/lib/sequence-elements/derive-token';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type { ElementVisionWorkflowInput } from '@/lib/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware, sequenceAccessMiddleware } from './middleware';

/**
 * E2E_RECORD=1 captures real upstream calls into fixtures. E2E_TEST=true with
 * E2E_RECORD unset is replay-only — vision calls would miss the fixture and
 * either error or capture an unwanted new fixture, so skip them in replay.
 */
function shouldRunVisionInE2E(): boolean {
  const env = getEnv();
  return env.E2E_TEST !== 'true' || env.E2E_RECORD === '1';
}

async function triggerElementVision(
  elementId: string,
  sequenceId: string,
  imageUrl: string,
  filename: string,
  teamId: string,
  userId: string
): Promise<void> {
  const input: ElementVisionWorkflowInput = {
    userId,
    teamId,
    sequenceId,
    elementId,
    imageUrl,
    filename,
  };
  await triggerWorkflow('/element-vision', input, {
    label: buildWorkflowLabel(sequenceId),
  });
}

// ============================================================================
// Presign upload
// ============================================================================

export const presignElementUploadFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        filename: z.string().min(1),
        sequenceId: ulidSchema.optional(),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const ext = getExtensionFromUrl(data.filename);
    const uploadId = generateId();
    const contentType = getMimeTypeFromExtension(ext);

    const storagePath = data.sequenceId
      ? `${context.teamId}/${data.sequenceId}/${uploadId}.${ext}`
      : `${context.teamId}/temp/${uploadId}.${ext}`;

    return getSignedUploadUrl(
      STORAGE_BUCKETS.ELEMENTS,
      storagePath,
      contentType
    );
  });

// ============================================================================
// Synchronously analyze a draft (pre-sequence) element via vision LLM.
//
// Draft uploads can't trigger the persisted element-vision workflow because the
// element row doesn't exist yet. Running vision inline here lets the Generate
// button gate on the result so we never hand the LLM a token with no visual
// context (the placeholder `(vision description pending)` path in
// scene-split-workflow). On promotion, the description is written straight onto
// the new row so we don't re-run vision twice.
// ============================================================================

export const analyzeDraftElementFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        publicUrl: z.string().url(),
        filename: z.string().min(1),
        token: z.string().min(1).max(100),
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (!shouldRunVisionInE2E()) {
      return { description: null, consistencyTag: null };
    }
    const openRouterApiKeyInfo =
      await context.scopedDb.apiKeys.resolveKey('openrouter');
    const result = await describeElementImage({
      imageUrl: data.publicUrl,
      filename: data.filename,
      token: data.token,
      openRouterApiKey: openRouterApiKeyInfo.key,
    });
    return {
      description: result.description,
      consistencyTag: result.consistencyTag,
    };
  });

// ============================================================================
// Finalize upload to an existing sequence
// ============================================================================

export const finalizeElementUploadFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        publicUrl: z.string().url(),
        path: z.string().min(1),
        filename: z.string().min(1),
      })
    )
  )
  .handler(async ({ context, data }) => {
    if (!data.path.startsWith(`elements/${context.teamId}/`)) {
      throw new Error('Invalid storage path');
    }

    const rawToken = deriveTokenFromFilename(data.filename);
    const token = await context.scopedDb.sequenceElements.ensureUniqueToken(
      data.sequenceId,
      rawToken
    );

    const element = await context.scopedDb.sequenceElements.create({
      id: generateId(),
      sequenceId: data.sequenceId,
      uploadedFilename: data.filename,
      token,
      imageUrl: data.publicUrl,
      imagePath: data.path,
      visionStatus: 'pending',
    });

    // Kick off vision workflow — do not block the upload response. During E2E
    // recording (E2E_RECORD=1) we still trigger so aimock captures the vision
    // call into a fixture; replay-only runs skip it.
    if (shouldRunVisionInE2E()) {
      await triggerElementVision(
        element.id,
        element.sequenceId,
        element.imageUrl,
        element.uploadedFilename,
        context.teamId,
        context.user.id
      );
    }

    return element;
  });

// ============================================================================
// List / delete / rename
// ============================================================================

export const listSequenceElementsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceElements.list(context.sequence.id);
  });

export const deleteSequenceElementFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(z.object({ sequenceId: ulidSchema, elementId: ulidSchema }))
  )
  .handler(async ({ context, data }) => {
    const element = await context.scopedDb.sequenceElements.getById(
      data.elementId
    );
    if (!element || element.sequenceId !== context.sequence.id) {
      throw new Error('Element not found');
    }
    await context.scopedDb.sequenceElements.delete(data.elementId);
    return { success: true };
  });

export const renameSequenceElementTokenFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        elementId: ulidSchema,
        token: z.string().min(1).max(100),
      })
    )
  )
  .handler(async ({ context, data }) => {
    const element = await context.scopedDb.sequenceElements.getById(
      data.elementId
    );
    if (!element || element.sequenceId !== context.sequence.id) {
      throw new Error('Element not found');
    }

    const cleaned = deriveTokenFromFilename(data.token);
    const unique = await context.scopedDb.sequenceElements.ensureUniqueToken(
      context.sequence.id,
      cleaned
    );

    return await context.scopedDb.sequenceElements.update(data.elementId, {
      token: unique,
    });
  });
