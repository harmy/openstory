import {
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  isValidAudioModel,
  isValidImageToVideoModel,
  isValidTextToImageModel,
  safeImageToVideoModel,
  safeTextToImageModel,
} from '@/lib/ai/models';
import {
  estimateAudioCost,
  estimateImageCost,
  estimateStoryboardCost,
  estimateVideoCost,
} from '@/lib/billing/cost-estimation';
import { multiplyMicros } from '@/lib/billing/money';
import { requireCredits } from '@/lib/billing/preflight';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import type { Shot, ShotVariant, NewShot } from '@/lib/db/schema';
import { buildPromoteUpdate } from '@/functions/shots';
import { buildShotImageWorkflowInput } from '@/lib/image/build-shot-image-input';
import {
  projectShotWithImage,
  type ShotWithImage,
} from '@/lib/shots/shot-with-image';
import { resolveMotionPrompt } from '@/lib/motion/resolve-motion-prompt';
import { VARIANT_TYPES, type VariantType } from '@/lib/db/schema/shot-variants';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import {
  createSequenceSchema,
  updateSequenceSchema,
} from '@/lib/schemas/sequence.schemas';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { triggerStoryboard } from '@/lib/workflow/launchers';
import type {
  BatchMotionMusicWorkflowInput,
  MusicSceneSummary,
  MusicWorkflowInput,
  StoryboardWorkflowInput,
} from '@/lib/workflow/types';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware, sequenceAccessMiddleware } from './middleware';
import { bumpStylePopularity } from '@/lib/style/bump-style-popularity';
import { getLogger } from '@/lib/observability/logger';
import { createSequences } from '@/lib/sequences/create-sequences';

const logger = getLogger(['openstory', 'serverFn', 'sequences']);

/**
 * Result of {@link addModelToSequenceFn}. `count` is the number of generation
 * units actually started (1 track for audio; eligible shots for video; shots
 * whose `/image` workflow successfully triggered for image). `failed` is the
 * number of units that failed to start — only ever non-zero for the image path,
 * which triggers one workflow per shot and tolerates partial failure. Mirrored
 * by `useAddModelToSequence`'s mutation generic.
 */
export type AddModelResult = {
  workflowRunId: string;
  variantType: VariantType;
  model: string;
  count: number;
  failed: number;
};

export const getSequencesFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequences.list();
  });

export const getSequenceFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    return context.sequence;
  });

/**
 * Create new sequence(s) with different analysis models.
 * Triggers storyboard generation workflow for each.
 *
 * The heavy lifting lives in `createSequences` (src/lib/sequences) so the
 * public API one-shot endpoint shares the exact same credit pre-flight,
 * fan-out, element promotion, and workflow trigger.
 */
export const createSequenceFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(createSequenceSchema))
  .handler(async ({ data, context }) => {
    const { sequences } = await createSequences(data, {
      scopedDb: context.scopedDb,
      user: context.user,
      teamId: context.teamId,
    });
    return sequences;
  });

/**
 * Update a sequence.
 * Triggers storyboard regeneration if script/style/aspectRatio/model changes.
 */
export const updateSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(updateSequenceSchema.extend({ sequenceId: ulidSchema }))
  )
  .handler(async ({ data, context }) => {
    const { sequenceId, ...updateData } = data;

    const needsRegeneration =
      updateData.script !== undefined ||
      updateData.styleId !== undefined ||
      updateData.aspectRatio !== undefined ||
      updateData.analysisModel !== undefined;

    const previousStyleId = context.sequence.styleId;

    const sequence = await context.scopedDb.sequences.update({
      id: sequenceId,
      aspectRatio: updateData.aspectRatio ?? DEFAULT_ASPECT_RATIO,
      ...updateData,
      status: needsRegeneration ? 'processing' : undefined,
    });

    // sequences.styleId is `.notNull() + onDelete: 'set null'` — TS types it as
    // non-null but the runtime value can be null after the parent style is
    // deleted. Keep the runtime guard despite what the type says.
    if (
      updateData.styleId !== undefined &&
      updateData.styleId !== previousStyleId &&
      sequence.styleId
    ) {
      bumpStylePopularity({
        scopedDb: context.scopedDb,
        styleId: sequence.styleId,
        sequenceIds: [sequence.id],
        teamId: context.teamId,
        userId: context.user.id,
      });
    }

    if (needsRegeneration) {
      await requireCredits(
        context.scopedDb,
        estimateStoryboardCost({
          imageModel: safeTextToImageModel(
            sequence.imageModel,
            DEFAULT_IMAGE_MODEL
          ),
          aspectRatio: sequence.aspectRatio,
          videoModels: [
            safeImageToVideoModel(sequence.videoModel, DEFAULT_VIDEO_MODEL),
          ],
        }),
        {
          providers: ['fal', 'openrouter'],
          errorMessage: 'Insufficient credits to regenerate storyboard',
        }
      );

      await triggerWorkflow(
        '/storyboard',
        {
          userId: context.user.id,
          teamId: context.teamId,
          sequenceId,
          options: {
            shotsPerScene: 3,
            generateThumbnails: true,
            generateDescriptions: true,
            aiProvider: 'openrouter',
            regenerateAll: true,
          },
          autoGenerateMotion: sequence.autoGenerateMotion,
          autoGenerateMusic: sequence.autoGenerateMusic,
        } satisfies StoryboardWorkflowInput,
        { label: buildWorkflowLabel(sequence.id) }
      );
    }

    return sequence;
  });

// ============================================================================
// Set Music Preference (theatre playback + MP4 export)
// ============================================================================

const setSequenceMusicInputSchema = z.object({
  sequenceId: ulidSchema,
  includeMusic: z.boolean(),
});

/**
 * Persist the per-sequence "include music in playback + export" toggle (#834).
 *
 * Deliberately separate from {@link updateSequenceFn}: that path force-defaults
 * `aspectRatio` and runs regeneration/credit logic, so reusing it for a
 * music-only write would silently reset a non-16:9 sequence's aspect ratio.
 * This is a minimal preference write with no side effects.
 */
export const setSequenceMusicFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(setSequenceMusicInputSchema))
  .handler(async ({ data, context }) => {
    return await context.scopedDb.sequences.update({
      id: data.sequenceId,
      includeMusic: data.includeMusic,
    });
  });

// ============================================================================
// Retry Failed Storyboard
// ============================================================================

const retryStoryboardInputSchema = z.object({
  sequenceId: ulidSchema,
});

/**
 * Retry a failed storyboard workflow.
 * Re-triggers the full analyze-script pipeline for the sequence.
 */
export const retryStoryboardFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(retryStoryboardInputSchema))
  .handler(async ({ context }) => {
    const { sequence, user, teamId } = context;

    if (sequence.status !== 'failed') {
      throw new Error('Only failed sequences can be retried');
    }

    await requireCredits(
      context.scopedDb,
      estimateStoryboardCost({
        imageModel: safeTextToImageModel(
          sequence.imageModel,
          DEFAULT_IMAGE_MODEL
        ),
        aspectRatio: sequence.aspectRatio,
        videoModels: [
          safeImageToVideoModel(sequence.videoModel, DEFAULT_VIDEO_MODEL),
        ],
      }),
      {
        providers: ['fal', 'openrouter'],
        errorMessage: 'Insufficient credits to retry storyboard',
      }
    );

    const workflowInput: StoryboardWorkflowInput = {
      userId: user.id,
      teamId,
      sequenceId: sequence.id,
      options: {
        shotsPerScene: 3,
        generateThumbnails: true,
        generateDescriptions: true,
        aiProvider: 'openrouter',
        regenerateAll: true,
      },
      autoGenerateMotion: sequence.autoGenerateMotion,
      autoGenerateMusic: sequence.autoGenerateMusic,
    };

    // Owns the generation mutex, the 'processing' status write, and the
    // run-id persistence (#839).
    await triggerStoryboard(context.scopedDb, workflowInput);

    return { success: true };
  });

/** Archive a sequence (hides from list, lets in-flight workflows finish) */
export const archiveSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(z.object({ sequenceId: ulidSchema })))
  .handler(async ({ context }) => {
    await context.scopedDb
      .sequence(context.sequence.id)
      .updateStatus('archived');
    return { success: true };
  });

/** Build compact scene summaries from shots for music prompt generation */
export function buildSceneSummaries(shots: Shot[]): MusicSceneSummary[] {
  return shots.map((shot) => {
    const md = shot.metadata?.musicDesign;
    const prompts = shot.metadata?.prompts;
    const legacyMusic = shot.metadata?.audioDesign?.music;
    const meta = shot.metadata?.metadata;
    const durationSeconds = shot.durationMs
      ? shot.durationMs / 1000
      : (meta?.durationSeconds ?? 10);

    return {
      sceneId: shot.id,
      location: meta?.location || '',
      timeOfDay: meta?.timeOfDay || '',
      visualSummary: prompts?.visual?.components.sceneDescription || '',
      title: meta?.title || 'Untitled Scene',
      storyBeat: meta?.storyBeat || '',
      durationSeconds,
      musicStyle: md?.style || legacyMusic?.style || '',
      musicMood: md?.mood || legacyMusic?.mood || '',
      musicPresence: md?.presence || legacyMusic?.presence || 'none',
      atmosphere: prompts?.visual?.components.atmosphere,
    };
  });
}

/**
 * Distinct audio models that have generated a track for this sequence (#546).
 * Drives the header audio-model dropdown.
 */
export const getSequenceAudioModelsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceVariants.listMusicModels(
      context.sequence.id
    );
  });

/** All music variant rows for a sequence (#546). */
export const getSequenceAudioVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.sequenceVariants.listMusicBySequence(
      context.sequence.id
    );
  });

/**
 * Throw if `model` is already on the sequence (#547). A model counts as
 * "already added" only when a NON-failed (pending/generating/completed) variant
 * row exists for it — a previously failed add can always be retried. Shared by
 * all three add-model branches; `label` ('image' | 'video' | 'audio') shapes
 * the error message.
 */
export function assertModelNotAlreadyAdded(
  existing: ReadonlyArray<{ model: string; status: string }>,
  model: string,
  label: VariantType
): void {
  if (existing.some((v) => v.model === model && v.status !== 'failed')) {
    throw new Error(`That ${label} model is already on this sequence`);
  }
}

/**
 * Shots eligible for a video add-model run (#547): only those with a completed
 * primary image to animate. A shot with no usable image is skipped — there is
 * nothing to feed image-to-video.
 */
export function selectEligibleVideoShots(
  // The still-image surface moved onto the anchor frame (#989); callers project
  // it back via `projectShotWithImage` so the thumbnail* reads here are stable.
  shots: readonly ShotWithImage[]
): ShotWithImage[] {
  return shots.filter(
    (f) => f.thumbnailStatus === 'completed' && Boolean(f.thumbnailUrl)
  );
}

/**
 * Sum a sequence's per-shot durations in seconds, falling back to 10s for any
 * shot whose duration is unknown. Shared by the add-audio and generate-music
 * paths; callers apply their own empty-sequence floor (`|| 30`).
 */
export function sumShotDurationsSeconds(
  shots: ReadonlyArray<Pick<Shot, 'durationMs' | 'metadata'>>
): number {
  return shots.reduce((sum, shot) => {
    const seconds = shot.durationMs
      ? shot.durationMs / 1000
      : (shot.metadata?.metadata?.durationSeconds ?? 10);
    return sum + seconds;
  }, 0);
}

/**
 * Build the music-workflow input for an ADD-MODEL audio run (#547). Always
 * `isPrimary: false`: an added audio model lands as an alternate in
 * `sequence_music_variants` and must never repoint the live `sequences.music*`
 * primary track. The music workflow defaults `isPrimary` to true (#546), so
 * omitting it here would clobber the user's working primary on both success AND
 * failure — the exact regression this helper exists to prevent.
 */
export function buildAddAudioMusicInput(args: {
  baseCtx: { userId: string; teamId: string; sequenceId: string };
  prompt: string;
  tags: string;
  durationSeconds: number;
  model: MusicWorkflowInput['model'];
}): MusicWorkflowInput {
  return {
    ...args.baseCtx,
    prompt: args.prompt,
    tags: args.tags,
    duration: args.durationSeconds,
    model: args.model,
    isPrimary: false,
  };
}

/**
 * Add a new image / video / audio model to an existing sequence (#547).
 * Generates that model's output for every eligible shot (image/video) or the
 * whole sequence (audio) using the EXISTING prompts — no re-analysis. Each unit
 * lands as a `shot_variants` row (image/video) or `sequence_music_variants`
 * row (audio), pre-stamped `pending` so the new model appears in the header
 * dropdown immediately. Reuses the per-shot image / motion-batch / music
 * workflows unchanged.
 */
export const addModelToSequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        variantType: z.enum(VARIANT_TYPES),
        model: z.string().min(1),
      })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequence, scopedDb, user } = context;
    const { variantType, model } = data;
    const baseCtx = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
    };

    // ── Audio: one new track for the sequence ──────────────────────────────
    if (variantType === 'audio') {
      if (!isValidAudioModel(model)) {
        throw new Error('Invalid audio model');
      }
      const existing = await scopedDb.sequenceVariants.listMusicBySequence(
        sequence.id
      );
      assertModelNotAlreadyAdded(existing, model, 'audio');
      if (!sequence.musicPrompt || !sequence.musicTags) {
        throw new Error(
          'Generate music once before adding another audio model'
        );
      }
      const allShots = await scopedDb.shots.listBySequence(sequence.id);
      const totalDuration = sumShotDurationsSeconds(allShots) || 30;

      await requireCredits(scopedDb, estimateAudioCost(model, totalDuration), {
        errorMessage: 'Insufficient credits to add this audio model',
      });

      await scopedDb.sequenceVariants.upsertMusicPrimary({
        sequenceId: sequence.id,
        model,
        prompt: sequence.musicPrompt,
        tags: sequence.musicTags,
        durationSeconds: Math.round(totalDuration),
        status: 'pending',
      });

      const musicInput = buildAddAudioMusicInput({
        baseCtx,
        prompt: sequence.musicPrompt,
        tags: sequence.musicTags,
        durationSeconds: totalDuration,
        model,
      });
      try {
        const workflowRunId = await triggerWorkflow('/music', musicInput, {
          deduplicationId: `add-audio-${sequence.id}-${model}-${Date.now()}`,
          label: buildWorkflowLabel(sequence.id),
        });
        return {
          workflowRunId,
          variantType,
          model,
          count: 1,
          failed: 0,
        } satisfies AddModelResult;
      } catch (error) {
        logger.error('add-model: failed to trigger music workflow', {
          err: error,
          sequenceId: sequence.id,
          model,
        });
        // Mark the pre-stamped row failed so the model can be re-added. Guard
        // the compensating write so its own failure can't mask the original
        // trigger error (which is what we want to surface to the user).
        try {
          await scopedDb.sequenceVariants.upsertMusicPrimary({
            sequenceId: sequence.id,
            model,
            prompt: sequence.musicPrompt,
            tags: sequence.musicTags,
            durationSeconds: Math.round(totalDuration),
            status: 'failed',
          });
        } catch (cleanupError) {
          logger.error('add-model: failed to mark music row failed', {
            err: cleanupError,
            sequenceId: sequence.id,
            model,
          });
        }
        throw error;
      }
    }

    // ── Video: animate every shot that already has an image ───────────────
    if (variantType === 'video') {
      if (!isValidImageToVideoModel(model)) {
        throw new Error('Invalid video model');
      }
      const existing = await scopedDb.shotVariants.listBySequence(
        sequence.id,
        'video'
      );
      assertModelNotAlreadyAdded(existing, model, 'video');
      const allShots = await scopedDb.shots.listBySequence(sequence.id);
      // Project each shot's anchor-frame image surface (#989) so eligibility and
      // the per-shot `imageUrl` read below keep using the legacy field names.
      await scopedDb.shots.ensureAnchorFrames(allShots);
      const anchorsByShot = new Map(
        (await scopedDb.frames.listAnchorsBySequence(sequence.id)).map((fr) => [
          fr.shotId,
          fr,
        ])
      );
      const shotsWithImage = allShots.flatMap((shot) => {
        const frame = anchorsByShot.get(shot.id);
        return frame ? [projectShotWithImage(shot, frame)] : [];
      });
      const eligible = selectEligibleVideoShots(shotsWithImage);
      if (eligible.length === 0) {
        throw new Error('No shots have a completed image to animate yet');
      }

      await requireCredits(
        scopedDb,
        multiplyMicros(estimateVideoCost(model, 5), eligible.length),
        { errorMessage: 'Insufficient credits to add this video model' }
      );

      for (const f of eligible) {
        await scopedDb.shotVariants.upsert({
          shotId: f.id,
          sequenceId: sequence.id,
          variantType: 'video',
          model,
          status: 'pending',
        });
      }

      const workflowInput: BatchMotionMusicWorkflowInput = {
        ...baseCtx,
        includeMusic: false,
        videoModels: [model],
        // Adding a video model lands as an alternate only — never the primary
        // video. Promote later with "Set". (#547)
        variantOnly: true,
        shots: eligible.map((f) => ({
          shotId: f.id,
          imageUrl: f.thumbnailUrl ?? '',
          prompt: resolveMotionPrompt(f, model),
          model,
          motionPrompt: f.metadata?.prompts?.motion,
          characterTags: f.metadata?.continuity?.characterTags,
          duration: f.durationMs
            ? f.durationMs / 1000
            : (f.metadata?.metadata?.durationSeconds ?? 3),
          aspectRatio: sequence.aspectRatio,
        })),
      };
      try {
        const workflowRunId = await triggerWorkflow(
          '/motion-batch',
          workflowInput,
          {
            deduplicationId: `add-video-${sequence.id}-${model}-${Date.now()}`,
            label: buildWorkflowLabel(sequence.id),
          }
        );
        return {
          workflowRunId,
          variantType,
          model,
          count: eligible.length,
          failed: 0,
        } satisfies AddModelResult;
      } catch (error) {
        logger.error('add-model: failed to trigger motion batch', {
          err: error,
          sequenceId: sequence.id,
          model,
          shots: eligible.length,
        });
        // Mark the pre-stamped pending rows failed so the model can be re-added.
        // Guard the compensating writes so they can't mask the original trigger
        // error that we re-throw to the user.
        try {
          await Promise.all(
            eligible.map((f) =>
              scopedDb.shotVariants.updateByShotAndModel(f.id, 'video', model, {
                status: 'failed',
                error: 'Failed to trigger motion batch',
              })
            )
          );
        } catch (cleanupError) {
          logger.error('add-model: failed to mark video rows failed', {
            err: cleanupError,
            sequenceId: sequence.id,
            model,
          });
        }
        throw error;
      }
    }

    // ── Image: re-render every shot's prompt with the new model ───────────
    if (!isValidTextToImageModel(model)) {
      throw new Error('Invalid image model');
    }
    // Image variants live in `frame_variants` now (#989) — check the models that
    // already have a version there rather than the retired `shot_variants(image)`.
    const existingImageModels =
      await scopedDb.frameVariants.listModelsForSequence(sequence.id);
    if (existingImageModels.includes(model)) {
      throw new Error(`Image model "${model}" has already been added`);
    }
    const allShots = await scopedDb.shots.listBySequence(sequence.id);
    // The image prompt lives on the anchor frame now (#989); load frames so each
    // shot's stored prompt can seed its `/image` run.
    await scopedDb.shots.ensureAnchorFrames(allShots);
    const imageFramesById = new Map(
      (await scopedDb.frames.listBySequence(sequence.id)).map((fr) => [
        fr.id,
        fr,
      ])
    );
    const [characters, locations, elements] = await Promise.all([
      scopedDb.characters.listWithSheets(sequence.id),
      scopedDb.sequenceLocations.listWithReferences(sequence.id),
      scopedDb.sequenceElements.list(sequence.id),
    ]);

    const inputs: NonNullable<
      Awaited<ReturnType<typeof buildShotImageWorkflowInput>>
    >[] = [];
    for (const f of allShots) {
      const input = await buildShotImageWorkflowInput({
        shot: f,
        model,
        userId: user.id,
        teamId: sequence.teamId,
        sequenceId: sequence.id,
        aspectRatio: sequence.aspectRatio,
        characters,
        locations,
        elements,
        imagePrompt: imageFramesById.get(f.id)?.imagePrompt ?? null,
        // Adding a model never repoints the primary — it lands as an alternate
        // variant only. Promote later with "Set". (#547)
        variantOnly: true,
      });
      if (input) inputs.push(input);
    }
    if (inputs.length === 0) {
      throw new Error('No shots have a prompt to generate from');
    }

    await requireCredits(
      scopedDb,
      multiplyMicros(
        estimateImageCost(model, sequence.aspectRatio, 1),
        inputs.length
      ),
      { errorMessage: 'Insufficient credits to add this image model' }
    );

    // Trigger one image workflow per shot. A single shot's trigger failure
    // shouldn't abort the rest of the batch — mark that shot's pending row
    // failed (so it doesn't block a future re-add) and continue. Only throw if
    // every shot failed to trigger.
    // No pre-seeded variant row: the IMAGE_WORKFLOW (variantOnly) appends the
    // in-flight `frame_variants` 'model' version itself in set-generating-status,
    // and its onFailure marks it failed — so there's nothing to pre-write here.
    let workflowRunId = '';
    let triggered = 0;
    for (const input of inputs) {
      try {
        workflowRunId = await triggerWorkflow('/image', input, {
          deduplicationId: `add-image-${input.shotId}-${model}-${Date.now()}`,
          label: buildWorkflowLabel(sequence.id),
        });
        triggered++;
      } catch (error) {
        // Log every per-shot trigger failure so a systemic cause (e.g. a
        // transient binding issue hitting half the batch) leaves an aggregated
        // Sentry trace rather than vanishing.
        logger.error('add-model: failed to trigger image workflow for shot', {
          err: error,
          sequenceId: sequence.id,
          shotId: input.shotId,
          model,
        });
      }
    }
    if (triggered === 0) {
      throw new Error('Failed to start image generation for any shot');
    }
    return {
      workflowRunId,
      variantType,
      model,
      count: triggered,
      failed: inputs.length - triggered,
    } satisfies AddModelResult;
  });

/**
 * Select the variant rows eligible to be promoted to the live primary for
 * `model` (#547). A row qualifies only when it is this model's LIVE completed
 * output: `status === 'completed'` with a `url`, and neither a divergent
 * (`divergedAt`) nor a user-discarded (`discardedAt`) alternate. Excluding
 * divergent/discarded is load-bearing — promoting one would resurrect an output
 * the user explicitly rejected onto the primary across the whole sequence.
 */
export function selectPromotableVariants(
  variants: readonly ShotVariant[],
  model: string
): ShotVariant[] {
  return variants.filter(
    (v) =>
      v.model === model &&
      v.status === 'completed' &&
      Boolean(v.url) &&
      v.divergedAt === null &&
      v.discardedAt === null
  );
}

/**
 * Build the primary-column update that promotes `variant` to the live primary
 * (#547). Reuses `buildPromoteUpdate` (which matches the per-scene
 * `setImageFromVariantFn` exactly for image, incl. clearing the now-stale
 * video). `buildPromoteUpdate`'s video case omits the motion-model / duration /
 * generated-at that `setVideoFromVariantFn` records, so layer those on for
 * parity. `now` is injectable for deterministic tests.
 */
export function buildSequencePromoteUpdate(
  variant: ShotVariant,
  variantType: 'image' | 'video',
  model: string,
  now: () => Date = () => new Date()
): Partial<NewShot> {
  const { update } = buildPromoteUpdate(variant);
  if (variantType === 'video') {
    return {
      ...update,
      motionModel: model,
      durationMs: variant.durationMs,
      videoGeneratedAt: now(),
    };
  }
  return update;
}

/**
 * Promote a model to the live primary across the WHOLE sequence (#547) — the
 * sequence-wide "Set" that pairs with the header image/video dropdowns. For
 * every shot that has a completed `shot_variants` row for `model`, copies that
 * row onto the legacy primary columns (the per-scene `setImageFromVariantFn` /
 * `setVideoFromVariantFn` applied in bulk, reusing `buildPromoteUpdate`). Shots
 * the model never generated are left on their current primary. Image promotion
 * invalidates each affected shot's video (the start image changed); video
 * promotion is terminal. Audio is per-sequence — use `setMusicFromVariantFn`.
 */
export const setSequenceModelFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        variantType: z.enum(['image', 'video']),
        model: z.string().min(1),
      })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequence, scopedDb, user } = context;
    const { variantType, model } = data;

    if (variantType === 'image' && !isValidTextToImageModel(model)) {
      throw new Error('Invalid image model');
    }
    if (variantType === 'video' && !isValidImageToVideoModel(model)) {
      throw new Error('Invalid video model');
    }

    // Image variants live in `frame_variants` now (#989). The sequence-wide
    // "Set" is a per-shot pointer repoint (the #677 fix applied in bulk): for
    // every shot with a completed version for `model`, select it and reset that
    // shot's now-stale video.
    if (variantType === 'image') {
      const versions = await scopedDb.frameVariants.listModelVersionsBySequence(
        sequence.id
      );
      const latestByFrame = new Map<string, (typeof versions)[number]>();
      for (const v of versions) {
        if (v.model !== model || v.status !== 'completed' || !v.url) continue;
        latestByFrame.set(v.frameId, v); // versions are asc id → last wins
      }
      if (latestByFrame.size === 0) {
        throw new Error('That model has not generated anything to set');
      }
      // Resolve each frame's owning shot — frame ids are NOT shot ids (#989) —
      // so the now-stale video reset targets the right shot row.
      const shotIdByFrame = new Map(
        (await scopedDb.frames.getByIds([...latestByFrame.keys()])).map((f) => [
          f.id,
          f.shotId,
        ])
      );
      let imageCount = 0;
      for (const [frameId, version] of latestByFrame) {
        await scopedDb.frameVariants.select(frameId, version.id, {
          actorId: user.id,
        });
        const ownerShotId = shotIdByFrame.get(frameId);
        if (ownerShotId) {
          await scopedDb.shots.update(
            ownerShotId,
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
        }
        imageCount++;
      }
      return { count: imageCount, variantType, model };
    }

    const variants = await scopedDb.shotVariants.listBySequence(
      sequence.id,
      variantType
    );
    const promotable = selectPromotableVariants(variants, model);
    if (promotable.length === 0) {
      throw new Error('That model has not generated anything to set');
    }

    let count = 0;
    for (const variant of promotable) {
      const shotUpdate = buildSequencePromoteUpdate(
        variant,
        variantType,
        model
      );
      const updated = await scopedDb.shots.update(variant.shotId, shotUpdate, {
        throwOnMissing: false,
      });
      if (updated) count++;
    }

    // A shot deleted mid-promotion is benign (throwOnMissing:false skips it),
    // but a promoted count short of the promotable set otherwise points at a
    // real problem (e.g. a scoping mismatch) — surface it rather than letting
    // the lower count pass silently.
    if (count !== promotable.length) {
      logger.warn('set-model: promoted fewer shots than promotable', {
        sequenceId: sequence.id,
        model,
        variantType,
        promotable: promotable.length,
        promoted: count,
      });
    }

    return { count, variantType, model };
  });

/**
 * Trigger sequence-level music generation.
 * Uses pre-generated prompt/tags when available, otherwise builds from shot audio specs.
 */
export const generateMusicFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        prompt: z.string().optional(),
        tags: z.string().optional(),
        model: z.string().optional(),
        duration: z.number().min(1).max(600).optional(),
      })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequence, user } = context;

    const effectivePrompt = data.prompt ?? sequence.musicPrompt;
    const effectiveTags = data.tags ?? sequence.musicTags;

    if (!effectivePrompt) {
      throw new Error(
        'Music prompt has not been generated yet — generate the storyboard first before editing music inputs.'
      );
    }
    if (!effectiveTags) {
      throw new Error('Music tags are required.');
    }

    // Persist the user's intent before triggering the workflow. Both
    // `data.prompt` and `data.tags` are surfaced as a single user-edit
    // revision; the variants helper updates the cached columns on `sequences`
    // alongside the row insert so a tags-only edit isn't dropped.
    if (data.prompt !== undefined || data.tags !== undefined) {
      await context.scopedDb.sequenceMusicPromptVersions.write({
        sequenceId: sequence.id,
        prompt: effectivePrompt,
        tags: effectiveTags,
        source: 'user-edit',
        createdBy: user.id,
      });
    }

    const allShots = await context.scopedDb.shots.listBySequence(
      data.sequenceId
    );

    const totalDuration = sumShotDurationsSeconds(allShots);

    const baseInput = {
      userId: user.id,
      teamId: sequence.teamId,
      sequenceId: sequence.id,
      duration: data.duration ?? (totalDuration || 30),
      model:
        data.model && isValidAudioModel(data.model) ? data.model : undefined,
    };

    const musicInput: MusicWorkflowInput = {
      ...baseInput,
      prompt: effectivePrompt,
      tags: effectiveTags,
    };

    await context.scopedDb.sequence(sequence.id).updateMusicFields({
      musicStatus: 'generating',
      musicError: null,
    });

    await triggerWorkflow('/music', musicInput, {
      label: buildWorkflowLabel(sequence.id),
    });

    return { success: true };
  });
