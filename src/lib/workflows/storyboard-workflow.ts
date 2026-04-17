/**
 * Storyboard generation workflow
 * Verifies sequence data, clears existing frames, then invokes script analysis
 */

import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  PREVIEW_IMAGE_MODEL,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/lib/ai/models.config';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import { StyleConfigSchema } from '@/lib/db/schema';
import { generateImageWithProvider } from '@/lib/image/image-generation';
import { buildPosterPrompt } from '@/lib/prompts/poster-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { validateSequenceAuth } from '@/lib/workflow/auth';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { StoryboardWorkflowInput } from '@/lib/workflow/types';
import { analyzeScriptWorkflow } from '@/lib/workflows/analyze-script-workflow';

export const generateStoryboardWorkflow =
  createScopedWorkflow<StoryboardWorkflowInput>(async (context, scopedDb) => {
    const input = context.requestPayload;

    const { sequenceId, teamId, userId } = input;

    console.log('[StoryboardWorkflow] Input received:', {
      sequenceId: input.sequenceId,
      teamId: input.teamId,
      userId: input.userId,
      autoGenerateMotion: input.autoGenerateMotion,
    });
    if (!sequenceId || !teamId || !userId) {
      throw new WorkflowValidationError(
        'Sequence ID, team ID, and user ID are required'
      );
    }
    const seq = scopedDb.sequence(sequenceId);

    const {
      title,
      script,
      aspectRatio,
      styleConfig,
      analysisModelId,
      imageModel,
      videoModel,
    } = await context.run('verify-clear-and-start-processing', async () => {
      validateSequenceAuth(input);

      const sequence = await scopedDb.sequences.getForUser({
        sequenceId,
      });

      if (!sequence.script || sequence.script.trim().length === 0) {
        throw new WorkflowValidationError('Sequence has no script');
      }

      if (!sequence.styleId) {
        throw new WorkflowValidationError('Sequence has no style selected');
      }

      const style = await scopedDb.styles.getById(sequence.styleId);

      if (!style) {
        throw new WorkflowValidationError('No style found');
      }

      const existingFrames = await scopedDb.frames.listBySequence(sequenceId);
      await Promise.all(
        existingFrames.map((frame) => scopedDb.frames.delete(frame.id))
      );

      await seq.updateStatus('processing');

      return {
        sequenceId: sequence.id,
        title: sequence.title,
        script: sequence.script,
        aspectRatio: sequence.aspectRatio,
        styleConfig: StyleConfigSchema.parse(style.config),
        analysisModelId:
          getAnalysisModelById(sequence.analysisModel)?.id ??
          DEFAULT_ANALYSIS_MODEL,
        imageModel: safeTextToImageModel(
          sequence.imageModel,
          DEFAULT_IMAGE_MODEL
        ),
        videoModel: safeImageToVideoModel(
          sequence.videoModel,
          DEFAULT_VIDEO_MODEL
        ),
      };
    });

    // Generate a poster image from the script for the video player empty state.
    // Non-critical — failures are logged and swallowed.
    await context.run('generate-poster', async () => {
      try {
        const prompt = buildPosterPrompt(title, script, styleConfig);
        const result = await generateImageWithProvider({
          model: PREVIEW_IMAGE_MODEL,
          prompt,
          imageSize: aspectRatioToImageSize(aspectRatio),
          traceName: 'poster-image',
        });

        const posterUrl = result.imageUrls[0];
        if (posterUrl) {
          await scopedDb.sequences.update({ id: sequenceId, posterUrl });
          await getGenerationChannel(sequenceId).emit(
            'generation.poster:ready',
            { posterUrl }
          );
        }
      } catch (error) {
        console.warn('[StoryboardWorkflow] Poster generation failed:', error);
      }
    });

    const label = buildWorkflowLabel(sequenceId);

    await context.invoke('analyze-script', {
      workflow: analyzeScriptWorkflow,
      workflowRunId: `analyze-script-${sequenceId}-${Date.now()}`,
      label,
      body: {
        userId: input.userId,
        teamId: input.teamId,
        sequenceId,
        script,
        aspectRatio,
        styleConfig,
        analysisModelId,
        imageModel,
        imageModels: input.imageModels ?? [imageModel],
        videoModel,
        autoGenerateMotion: input.autoGenerateMotion ?? false,
        autoGenerateMusic: input.autoGenerateMusic ?? false,
        musicModel: input.musicModel,
        suggestedTalentIds: input.suggestedTalentIds,
        suggestedLocationIds: input.suggestedLocationIds,
      },
      retries: 3,
      retryDelay: 'pow(2, retried) * 1000',
    });

    await context.run('mark-completed', async () => {
      await seq.updateStatus('completed');
    });

    await context.run('emit-complete', async () => {
      await getGenerationChannel(sequenceId).emit('generation.complete', {
        sequenceId,
      });
    });
  });
