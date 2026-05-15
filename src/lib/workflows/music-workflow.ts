import { computeSequenceMusicInputHash } from '@/lib/ai/input-hash';
import { DEFAULT_MUSIC_MODEL } from '@/lib/ai/models';
import { uploadAudioToStorage } from '@/lib/audio/audio-storage';
import { generateMusic } from '@/lib/audio/music-generation';
import { ZERO_MICROS, microsToUsd } from '@/lib/billing/money';
import { getGenerationChannel } from '@/lib/realtime';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { MusicWorkflowInput } from '@/lib/workflow/types';

export const generateMusicWorkflow = createScopedWorkflow<MusicWorkflowInput>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const { prompt, tags, duration } = input;

    if (!prompt || !tags || !duration) {
      throw new WorkflowValidationError(
        'Either prompt+tags+duration are required for music generation'
      );
    }

    const { sequenceId, teamId } = input;
    const model = input.model || DEFAULT_MUSIC_MODEL;

    if (sequenceId) {
      await context.run('set-generating-status', async () => {
        await scopedDb.sequence(sequenceId).updateMusicFields({
          musicStatus: 'generating',
          musicModel: model,
          musicError: null,
        });

        await getGenerationChannel(sequenceId).emit(
          'generation.audio:progress',
          {
            status: 'generating',
          }
        );
      });
    }

    const audioResult = await context.run('generate-music', async () => {
      const result = await generateMusic({
        prompt,
        tags,
        duration,
        instrumental: true,
        model,
        traceName: 'sequence-music',
        scopedDb,
      });

      if (!result.success || !result.audioUrl) {
        throw new Error(result.error || 'Music generation failed');
      }

      return result;
    });

    const actualDuration =
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      typeof audioResult.metadata?.duration === 'number'
        ? audioResult.metadata.duration
        : // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
          (input.duration ?? 60);

    // Deduct credits (skip if team used own fal key)
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    const musicCostMicros = audioResult.metadata?.cost ?? ZERO_MICROS;
    if (musicCostMicros > 0 && !audioResult.metadata.usedOwnKey) {
      await context.run('deduct-credits', async () => {
        const canAfford =
          await scopedDb.billing.hasEnoughCredits(musicCostMicros);
        if (!canAfford) {
          console.warn(
            `[MusicWorkflow] Insufficient credits for team ${teamId} (cost: $${microsToUsd(musicCostMicros).toFixed(4)}), skipping deduction`
          );
          return;
        }
        await scopedDb.billing.deductCredits(musicCostMicros, {
          description: `Music generation (${model})`,
          metadata: {
            model,
            sequenceId,
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
            duration: audioResult.metadata?.duration,
          },
        });
      });
    }

    if (!audioResult.audioUrl) {
      throw new Error('Audio URL missing from generation result');
    }
    let audioUrl = audioResult.audioUrl;
    if (sequenceId) {
      const storageResult = await context.run('upload-to-storage', async () => {
        const result = await uploadAudioToStorage({
          audioUrl,
          teamId,
          sequenceId,
          sequenceTitle: 'sequence',
          sceneTitle: 'music',
        });

        if (!result.success || !result.path) {
          throw new Error('Failed to upload audio');
        }

        return { path: result.path, url: result.url };
      });
      if (storageResult.url) {
        audioUrl = storageResult.url;
      }
      const inputHash = await computeSequenceMusicInputHash({
        prompt,
        tags,
        durationSeconds: actualDuration,
        audioModel: model,
      });

      const writeResult = await context.run('write-music-variant', async () => {
        return scopedDb.sequenceVariants.writeMusicVariant({
          sequenceId,
          url: audioUrl,
          storagePath: storageResult.path,
          prompt,
          tags,
          durationSeconds: actualDuration,
          model,
          status: 'completed',
          generatedAt: new Date(),
          error: null,
          inputHash,
        });
      });

      if (writeResult.divergent) {
        // Divergent run: prior primary on `sequences.music*` stays
        // authoritative. Reset musicStatus from 'generating' (set above) back
        // to 'completed' and emit a terminal event so the UI doesn't hang on
        // a spinner. The alternate is preserved in `sequence_music_variants`
        // for future surfacing.
        const divergedVariantId = writeResult.variant.id;
        await context.run('update-sequence-music-divergent', async () => {
          const seq = scopedDb.sequence(sequenceId);
          const status = await seq.getMusicStatus();
          await seq.updateMusicFields({
            musicStatus: 'completed',
            musicError: null,
          });

          const channel = getGenerationChannel(sequenceId);
          await channel.emit('generation.audio:progress', {
            status: 'completed',
            ...(status?.musicUrl ? { audioUrl: status.musicUrl } : {}),
          });
          await channel.emit('generation.stale:detected', {
            entityType: 'sequence',
            entityId: sequenceId,
            artifact: 'music',
            snapshotInputHash: inputHash,
            divergedVariantId,
          });
        });
        console.log(
          `[MusicWorkflow] Diverged music result for sequence ${sequenceId}; preserved as alternate (variant=${divergedVariantId})`
        );
      } else {
        await context.run('update-sequence-music', async () => {
          await scopedDb.sequence(sequenceId).updateMusicFields({
            musicUrl: audioUrl,
            musicPath: storageResult.path,
            musicStatus: 'completed',
            musicGeneratedAt: new Date(),
            musicError: null,
          });

          await getGenerationChannel(sequenceId).emit(
            'generation.audio:progress',
            {
              status: 'completed',
              audioUrl: audioUrl,
            }
          );
        });
      }

      // TODO: Tom Mar 2026 - Add a step to generate a music track for each scene
    }

    return { audioUrl: audioUrl, duration: actualDuration };
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);
      if (input.sequenceId) {
        const failSeq = scopedDb.sequence(input.sequenceId);

        await failSeq.updateMusicFields({
          musicStatus: 'failed',
          musicError: error,
        });

        try {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.audio:progress',
            { status: 'failed' }
          );
        } catch (emitError) {
          console.error(
            `[MusicWorkflow] Failed to emit failure event for sequence ${input.sequenceId}:`,
            emitError
          );
        }
      }
      console.error(
        '[MusicWorkflow]',
        `Music generation failed for sequence ${input.sequenceId}: ${error}`
      );
      return `Music generation failed for sequence ${input.sequenceId}`;
    },
  }
);
