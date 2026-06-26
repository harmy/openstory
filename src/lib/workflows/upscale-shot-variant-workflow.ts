/**
 * Upscale a chosen 3×3 grid tile into the frame's primary still (#989).
 *
 * The picked tile is cropped (a Cloudflare Image Resizing URL) by
 * `selectShotVariantFn`, then this workflow upscales it and records the result
 * as a `kind:'framing'` `frame_variants` version (`sourceVariantId` = the grid
 * sheet it came from) and SELECTS it — a pointer repoint that mirrors the new
 * still onto the frame, never an overwrite. Downstream video (still on `shots`
 * until Phase 3) is reset because the anchor still changed.
 */

import { IMAGE_MODELS } from '@/lib/ai/models';
import { ZERO_MICROS } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import {
  aspectRatioToImageSize,
  DEFAULT_IMAGE_SIZE,
} from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { uploadImageToStorage } from '@/lib/image/image-storage';
import { buildReferenceImagePrompt } from '@/lib/prompts/reference-image-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  UpscaleShotVariantWorkflowInput,
  UpscaleShotVariantWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'upscale-shot-variant']);

const UPSCALE_PROMPT = `Upscale this image to a clean, high-resolution shot suitable for animation.

RENDERING RULES
- Keep the original scene, pose, framing and camera angle IDENTICAL.
- Preserve the identity of all real people:
  - Do NOT change their faces, expressions, hairstyles, or clothing.
  - Do NOT add new people or remove existing people.
- Faces:
  - Make faces sharp and detailed.
  - Clear eyes, natural skin texture, no plastic or over-smoothed look.
- Text & logos:
  - Preserve all printed text, signage, and logos exactly as they appear.
  - Re-render text cleanly at higher resolution.
  - Do NOT invent new words, change names, or move signs.
- Style:
  - Realistic photographic look.
  - Keep original colours, lighting and depth of field.
  - No extra filters, bokeh, vignettes, film grain, or stylistic changes unless they already exist.

OUTPUT
- A SINGLE high-resolution image.
- Aspect ratio: match the original exactly.
- Resolution: upscale to animation-ready quality.
- No text overlays, borders, watermarks, or new graphics added by the model.`;

export class UpscaleShotVariantWorkflow extends OpenStoryWorkflowEntrypoint<UpscaleShotVariantWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<UpscaleShotVariantWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<UpscaleShotVariantWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;

    const { sequenceId, teamId, shotId, userId } = input;
    if (!sequenceId || !teamId || !shotId) {
      throw new WorkflowValidationError('sequenceId and teamId are required');
    }

    logger.info(
      `[UpscaleShotVariantWorkflow] Starting upscale for shot ${shotId}`
    );

    const upscaleResult = await step.do('upscale-image', async () => {
      await getGenerationChannel(sequenceId).emit('generation.image:progress', {
        shotId,
        status: 'generating',
      });

      const frame = await scopedDb.frames.getById(shotId);
      if (!frame) {
        logger.info(
          `[UpscaleShotVariantWorkflow] Shot ${shotId} has no anchor frame, skipping`
        );
        return null;
      }

      // Record the in-flight framing version (the upscaled tile), pointing back
      // at the grid sheet it was cropped from.
      const version = await scopedDb.frameVariants.appendVersion({
        frameId: shotId,
        sequenceId,
        kind: 'framing',
        model: 'nano_banana_2',
        sourceVariantId: input.sourceVariantId ?? null,
        status: 'generating',
        workflowRunId,
      });

      const allReferences = [
        ...(input.characterReferences ?? []).map((r) => ({
          ...r,
          role: r.role ?? ('character' as const),
        })),
        ...(input.locationReferences ?? []).map((r) => ({
          ...r,
          role: r.role ?? ('location' as const),
        })),
      ];
      const { prompt: enhancedPrompt, referenceUrls: charLocUrls } =
        buildReferenceImagePrompt(
          UPSCALE_PROMPT,
          allReferences,
          IMAGE_MODELS.nano_banana_2.maxPromptLength
        );

      const imageSize = input.aspectRatio
        ? aspectRatioToImageSize(input.aspectRatio)
        : DEFAULT_IMAGE_SIZE;

      const result = await generateImageWithProvider(
        {
          model: 'nano_banana_2',
          prompt: enhancedPrompt,
          imageSize,
          referenceImageUrls: [input.croppedTileUrl, ...charLocUrls],
          numImages: 1,
          outputFormat: 'png',
        },
        { scopedDb }
      );
      return {
        imageUrl: result.imageUrls[0],
        cost: result.metadata.cost ?? ZERO_MICROS,
        usedOwnKey: result.metadata.usedOwnKey,
        versionId: version.id,
      };
    });

    if (!upscaleResult) {
      return { upscaledUrl: '', upscaledPath: '' };
    }

    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: upscaleResult.cost,
        usedOwnKey: upscaleResult.usedOwnKey,
        description: 'Variant upscale (nano_banana_2)',
        idempotencyKey: `${event.instanceId}:upscale`,
        metadata: { shotId, sequenceId },
        workflowName: 'UpscaleShotVariantWorkflow',
      });
    });

    const storageResult = await step.do('upload-to-storage', async () => {
      if (!upscaleResult.imageUrl) {
        throw new Error('Upscale did not return an image URL');
      }
      const result = await uploadImageToStorage({
        imageUrl: upscaleResult.imageUrl,
        teamId,
        sequenceId,
        shotId,
      });
      if (!result.url) {
        throw new Error('Failed to upload upscaled image to storage');
      }
      return { url: result.url, path: result.path };
    });

    await step.do('select-upscaled-version', async () => {
      await scopedDb.frameVariants.update(upscaleResult.versionId, {
        status: 'completed',
        url: storageResult.url,
        storagePath: storageResult.path || null,
        generatedAt: new Date(),
        error: null,
      });

      // Repoint the frame's selection at the upscaled tile (mirror + event).
      await scopedDb.frameVariants.select(shotId, upscaleResult.versionId, {
        actorId: userId,
      });

      // New still → reset the shot's downstream video.
      await scopedDb.shots.update(
        shotId,
        {
          videoUrl: null,
          videoPath: null,
          videoStatus: 'pending',
          videoWorkflowRunId: null,
          videoGeneratedAt: null,
          videoError: null,
        },
        { throwOnMissing: false }
      );

      await getGenerationChannel(sequenceId).emit('generation.image:progress', {
        shotId,
        status: 'completed',
        thumbnailUrl: storageResult.url,
      });

      logger.info(
        `[UpscaleShotVariantWorkflow] Upscale completed + selected for shot ${shotId}`
      );
    });

    return {
      upscaledUrl: storageResult.url,
      upscaledPath: storageResult.path || '',
    } satisfies UpscaleShotVariantWorkflowResult;
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<UpscaleShotVariantWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;
    logger.error(
      `[UpscaleShotVariantWorkflow] Upscale failed for shot ${input.shotId}: ${error}`
    );
    if (!input.shotId || !input.teamId) return;

    // Mark the in-flight framing version failed; the frame's PRIOR selection is
    // untouched, so revert the UI to the real selected still rather than showing
    // a false failure on a good image.
    await scopedDb.frameVariants.markFailedByWorkflowRun(
      event.instanceId,
      error
    );
    if (input.sequenceId) {
      const frame = await scopedDb.frames.getById(input.shotId);
      await getGenerationChannel(input.sequenceId).emit(
        'generation.image:progress',
        {
          shotId: input.shotId,
          status: 'completed',
          ...(frame?.imageUrl ? { thumbnailUrl: frame.imageUrl } : {}),
        }
      );
    }
  }
}
