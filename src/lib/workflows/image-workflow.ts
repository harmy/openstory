import { computeVisualPromptInputHash } from '@/lib/ai/input-hash';
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '@/lib/ai/models';
import { loadNarrowFramePromptContext } from '@/lib/ai/prompt-context';
import { ZERO_MICROS, microsToUsd } from '@/lib/billing/money';
import { DEFAULT_IMAGE_SIZE } from '@/lib/constants/aspect-ratios';
import {
  generateImageWithProvider,
  type ImageGenerationParams,
} from '@/lib/image/image-generation';
import { uploadImageToStorage } from '@/lib/image/image-storage';
import { buildReferenceImagePrompt } from '@/lib/prompts/reference-image-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { simpleHash } from '@/lib/utils/hash';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { ImageWorkflowInput } from '@/lib/workflow/types';
import {
  computeImageWorkflowHashCurrent,
  computeImageWorkflowHashFromDto,
  persistImageResult,
} from './image-workflow-snapshot';
import { shouldRecordUserEdit } from './user-edit-predicate';

type ImageWorkflowResult = {
  imageUrl: string;
  frameId?: string;
  sequenceId?: string;
};

export const generateImageWorkflow = createScopedWorkflow<
  ImageWorkflowInput,
  ImageWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;

    // Upstash swallows runStarted-middleware throws to console.error, so
    // payload-tamper detection only halts the run from inside `context.run`.
    if (input.sceneSnapshot) {
      await context.run('validate-snapshot', async () => {
        if (!context.snapshot) {
          throw new Error(
            '[ImageWorkflow] sceneSnapshot is present but context.snapshot is undefined — snapshot extension is not configured for this workflow runtime'
          );
        }
        await context.snapshot.validate();
      });
    }

    const snapshotHash: string | null =
      input.sceneSnapshot && input.snapshotInputHash
        ? input.snapshotInputHash
        : null;

    const generationParams = await context.run(
      'set-generating-status',
      async (): Promise<ImageGenerationParams | null> => {
        if (!input.prompt.trim()) {
          throw new WorkflowValidationError(
            'Prompt is required for image generation'
          );
        }

        console.log(
          '[ImageWorkflow]',
          `Starting image generation for user ${input.userId}`
        );

        const model = input.model ?? DEFAULT_IMAGE_MODEL;

        if (input.frameId) {
          const frame = await scopedDb.frames.update(
            input.frameId,
            {
              thumbnailStatus: 'generating',
              thumbnailWorkflowRunId: context.workflowRunId,
              imageModel: model,
            },
            { throwOnMissing: false }
          );

          if (!frame) {
            console.log(
              '[ImageWorkflow]',
              `Frame ${input.frameId} was deleted, skipping`
            );
            return null;
          }

          if (
            shouldRecordUserEdit({
              userEditedPrompt: input.userEditedPrompt,
              prompt: input.prompt,
              currentPrompt: frame.imagePrompt,
            })
          ) {
            // Stamp the user-edit with the upstream-context hash captured at
            // edit time so staleness detection survives a hand-typed prompt.
            // If anything blocks the compute (no sequenceId, style deleted,
            // missing scene metadata), fall back to null — the staleness
            // function reaches back to an earlier non-null row.
            let userEditInputHash: string | null = null;
            let userEditAnalysisModel: string | null = null;
            try {
              if (frame.metadata && input.sequenceId) {
                const sequence = await scopedDb.sequences.getById(
                  input.sequenceId
                );
                if (sequence) {
                  const ctx = await loadNarrowFramePromptContext({
                    scopedDb,
                    sequence: {
                      id: sequence.id,
                      styleId: sequence.styleId,
                      aspectRatio: sequence.aspectRatio,
                      analysisModel: sequence.analysisModel,
                    },
                    scene: frame.metadata,
                  });
                  userEditInputHash = await computeVisualPromptInputHash(ctx);
                  userEditAnalysisModel = ctx.analysisModel;
                }
              }
            } catch (err) {
              console.warn(
                `[ImageWorkflow] Could not compute upstream hash for user-edit on frame ${input.frameId}; recording with null hash`,
                err
              );
            }

            await scopedDb.framePromptVariants.write({
              frameId: input.frameId,
              promptType: 'visual',
              text: input.prompt,
              source: 'user-edit',
              inputHash: userEditInputHash,
              analysisModel: userEditAnalysisModel,
              createdBy: input.userId,
            });
          }

          // Dual-write: upsert frame_variants row
          if (input.sequenceId) {
            await scopedDb.frameVariants.upsert({
              frameId: input.frameId,
              sequenceId: input.sequenceId,
              variantType: 'image',
              model,
              status: 'generating',
              workflowRunId: context.workflowRunId,
            });
          }

          await getGenerationChannel(input.sequenceId).emit(
            'generation.image:progress',
            { frameId: input.frameId, status: 'generating', model }
          );
        }

        return {
          model,
          prompt: buildReferenceImagePrompt(
            input.prompt,
            input.referenceImages ?? [],
            IMAGE_MODELS[model].maxPromptLength
          ).prompt,
          imageSize: input.imageSize ?? DEFAULT_IMAGE_SIZE,
          numImages: input.numImages ?? 1,
          seed: input.seed,
          referenceImageUrls:
            input.referenceImages?.map((ref) => ref.referenceImageUrl) ?? [],
          traceName: 'frame-image',
        } satisfies ImageGenerationParams;
      }
    );

    if (!generationParams) {
      return {
        imageUrl: '',
        frameId: input.frameId,
        sequenceId: input.sequenceId,
      } satisfies ImageWorkflowResult;
    }

    const imageResult = await context.run('generate-image', async () => {
      console.log(
        '[ImageWorkflow]',
        `Generating image ${input.frameId} with model ${generationParams.model}`
      );
      return generateImageWithProvider(generationParams, { scopedDb });
    });

    const imageCostMicros = imageResult.metadata.cost ?? ZERO_MICROS;
    const { teamId, frameId, sequenceId } = input;
    if (imageCostMicros > 0 && teamId && !imageResult.metadata.usedOwnKey) {
      await context.run('deduct-credits', async () => {
        if (!(await scopedDb.billing.hasEnoughCredits(imageCostMicros))) {
          console.warn(
            `[ImageWorkflow] Insufficient credits for team ${teamId} (cost: $${microsToUsd(imageCostMicros).toFixed(4)}), skipping deduction`
          );
          return;
        }
        await scopedDb.billing.deductCredits(imageCostMicros, {
          description: `Image generation (${generationParams.model})`,
          metadata: {
            model: generationParams.model,
            frameId: input.frameId,
            sequenceId: input.sequenceId,
          },
        });
      });
    }

    let imageUrl: string = imageResult.imageUrls[0];

    if (imageUrl && frameId && sequenceId && teamId && !input.skipStorage) {
      // Step 1: durable R2 upload. Isolated so a transient failure in the
      // downstream divergence/persist step doesn't re-upload (and leak) the
      // R2 object on QStash retry. Upstash persists the return value so
      // retries of any later step see the same url+path.
      const upload = await context.run('upload-image', async () => {
        return uploadImageToStorage({
          imageUrl,
          teamId,
          sequenceId,
          frameId,
        });
      });

      // Step 2: divergence check + DB writes + emit. Idempotent on retry —
      // frame.update + variants.updateByFrameAndModel are last-write-wins,
      // and insertDivergent pre-checks (frame, type, model, inputHash).
      const writeResult = await context.run('persist-result', async () => {
        const promptHash = input.prompt ? simpleHash(input.prompt) : null;
        const { model } = generationParams;

        // Re-resolve current sheet hashes when the caller opted into the
        // snapshot pattern. A divergence between the trigger-time snapshot
        // and the current state means the references that produced this
        // image are no longer authoritative — preserve the result as a
        // divergent alternate instead of overwriting the primary thumbnail.
        const currentHash =
          snapshotHash && context.snapshot
            ? await context.snapshot.computeCurrent()
            : null;

        const outcome = await persistImageResult({
          scopedDb,
          frameId,
          sequenceId,
          model,
          upload,
          snapshotHash,
          currentHash,
          promptHash,
          emit: async (event, payload) => {
            await getGenerationChannel(sequenceId).emit(event, payload);
          },
        });

        if (outcome.status === 'frame-deleted') {
          console.log(
            '[ImageWorkflow]',
            `Frame ${frameId} was deleted, skipping persist`
          );
          return null;
        }

        if (outcome.status === 'divergent' && snapshotHash) {
          console.log(
            '[ImageWorkflow]',
            `Diverged frame ${frameId}: snapshot=${snapshotHash.slice(0, 8)} current=${currentHash?.slice(0, 8)}; routed alternate to frame_variants`
          );
        } else {
          console.log('[ImageWorkflow]', `Uploaded to storage: ${upload.path}`);
        }

        return { imageUrl: outcome.imageUrl };
      });
      if (writeResult) imageUrl = writeResult.imageUrl;
    } else if (imageUrl && frameId && input.skipStorage) {
      // Preview mode: store fal.ai CDN URL in dedicated preview field
      await context.run('store-preview-url', async () => {
        const updatedFrame = await scopedDb.frames.update(
          frameId,
          {
            previewThumbnailUrl: imageUrl,
            thumbnailGeneratedAt: new Date(),
            thumbnailError: null,
          },
          { throwOnMissing: false }
        );

        if (!updatedFrame) {
          console.log(
            '[ImageWorkflow]',
            `Frame ${frameId} was deleted, skipping preview update`
          );
          return;
        }

        if (sequenceId) {
          await getGenerationChannel(sequenceId).emit(
            'generation.image:progress',
            { frameId, previewThumbnailUrl: imageUrl }
          );
        }
      });
    }

    return { imageUrl, frameId, sequenceId };
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const input = context.requestPayload;
      // Skipping storage means we're in preview mode
      const previewMode = input.skipStorage;
      if (!previewMode) {
        // Only flag the frame as failed if we're not in preview mode
        const error = sanitizeFailResponse(failResponse);

        if (input.frameId && input.teamId) {
          await scopedDb.frames.update(
            input.frameId,
            { thumbnailStatus: 'failed', thumbnailError: error },
            { throwOnMissing: false }
          );

          // Dual-write: update frame_variants row (returns null if row doesn't exist)
          const model = input.model ?? DEFAULT_IMAGE_MODEL;
          if (input.sequenceId) {
            await scopedDb.frameVariants.updateByFrameAndModel(
              input.frameId,
              'image',
              model,
              { status: 'failed', error }
            );
          }

          if (input.sequenceId) {
            try {
              await getGenerationChannel(input.sequenceId).emit(
                'generation.image:progress',
                { frameId: input.frameId, status: 'failed', model }
              );
            } catch (emitError) {
              console.error(
                `[ImageWorkflow] Failed to emit failure event for sequence ${input.sequenceId} frame ${input.frameId}:`,
                emitError
              );
            }
          }
        }

        console.error(
          '[ImageWorkflow]',
          `Image generation failed for frame ${input.frameId}: ${error}`
        );
      }

      return `Image generation failed for frame ${input.frameId}`;
    },
    snapshot: {
      computeFromDto: (input) => computeImageWorkflowHashFromDto(input),
      computeCurrent: (input, scopedDb) =>
        computeImageWorkflowHashCurrent(input, scopedDb),
    },
  }
);
