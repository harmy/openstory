import {
  computeMotionPromptInputHash,
  computeMusicPromptInputHash,
  computeVisualPromptInputHash,
} from '@/lib/ai/input-hash';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/lib/ai/models.config';
import {
  loadFramePromptContext,
  narrowFramePromptContext,
} from '@/lib/ai/prompt-context';
import {
  FRAME_PROMPT_TYPES,
  type ShotPromptVariant,
  type SequenceMusicPromptVariant,
} from '@/lib/db/schema';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { simpleHash } from '@/lib/utils/hash';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type {
  MotionPromptSceneWorkflowInput,
  MusicPromptWorkflowInput,
  VisualPromptSceneWorkflowInput,
} from '@/lib/workflow/types';
import { buildMusicSceneSummaries } from '@/lib/workflows/music-scene-summaries';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { frameAccessMiddleware, sequenceAccessMiddleware } from './middleware';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'serverFn', 'prompt-variants']);

const promptTypeSchema = z.enum(FRAME_PROMPT_TYPES);

/**
 * Stable deduplication ID for frame-prompt regeneration. Workflow retries with
 * the same upstream context must collapse to a single run, so this string
 * cannot include timestamps or random suffixes.
 */
export function framePromptDedupId(
  promptType: 'visual' | 'motion',
  shotId: string,
  liveHash: string
): string {
  return `prompt-${promptType}-${shotId}-${liveHash}`;
}

/**
 * Unique deduplication ID for an explicit user-driven force-regeneration.
 * Distinct from `framePromptDedupId` because the user is asking for a fresh
 * LLM completion regardless of whether upstream inputs changed — collapsing
 * repeat clicks to one run would silently swallow the regeneration.
 */
export function framePromptForceDedupId(
  promptType: 'visual' | 'motion',
  shotId: string,
  nonce: string
): string {
  return `prompt-${promptType}-${shotId}-force-${nonce}`;
}

/** Stable deduplication ID for music-prompt regeneration — see above. */
export function musicPromptDedupId(
  sequenceId: string,
  liveHash: string
): string {
  return `music-prompt-${sequenceId}-${liveHash}`;
}

/** True when a cached hash means there is no work for the regeneration to do. */
export function isPromptUpToDate(
  storedHash: string | null,
  liveHash: string
): boolean {
  return storedHash !== null && storedHash === liveHash;
}

export type ShotPromptVariantWithAuthor = ShotPromptVariant & {
  createdByName: string | null;
};

export type SequenceMusicPromptVariantWithAuthor =
  SequenceMusicPromptVariant & { createdByName: string | null };

const frameListInput = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  promptType: promptTypeSchema,
});

export const listShotPromptVariantsFn = createServerFn({ method: 'GET' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameListInput))
  .handler(
    async ({ context, data }): Promise<ShotPromptVariantWithAuthor[]> => {
      return await context.scopedDb.shotPromptVariants.listByFrameWithAuthor(
        data.shotId,
        data.promptType
      );
    }
  );

const sequenceListInput = z.object({ sequenceId: ulidSchema });

export const listSequenceMusicPromptVariantsFn = createServerFn({
  method: 'GET',
})
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(sequenceListInput))
  .handler(
    async ({
      context,
      data,
    }): Promise<SequenceMusicPromptVariantWithAuthor[]> => {
      return await context.scopedDb.sequenceMusicPromptVariants.listBySequenceWithAuthor(
        data.sequenceId
      );
    }
  );

// Restore carries the source variant's input_hash forward so staleness keeps
// tracking the upstream context — restoring an old AI prompt without the hash
// would short-circuit the staleness check to "fresh" forever.
const frameRestoreInput = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  variantId: ulidSchema,
});

export const restoreShotPromptVariantFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameRestoreInput))
  .handler(async ({ context, data }) => {
    const chosen = await context.scopedDb.shotPromptVariants.getByIdForFrame(
      data.variantId,
      data.shotId
    );
    if (!chosen) {
      throw new Error('Prompt variant not found for this frame');
    }

    const inserted = await context.scopedDb.shotPromptVariants.write({
      shotId: data.shotId,
      promptType: chosen.promptType,
      text: chosen.text,
      components: chosen.components,
      parameters: chosen.parameters,
      source: 'restored',
      inputHash: chosen.inputHash,
      analysisModel: chosen.analysisModel,
      createdBy: context.user.id,
    });
    return { variantId: inserted.id };
  });

const sequenceRestoreInput = z.object({
  sequenceId: ulidSchema,
  variantId: ulidSchema,
});

export const restoreSequenceMusicPromptVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(sequenceRestoreInput))
  .handler(async ({ context, data }) => {
    const chosen =
      await context.scopedDb.sequenceMusicPromptVariants.getByIdForSequence(
        data.variantId,
        data.sequenceId
      );
    if (!chosen) {
      throw new Error('Music prompt variant not found for this sequence');
    }

    const inserted = await context.scopedDb.sequenceMusicPromptVariants.write({
      sequenceId: data.sequenceId,
      prompt: chosen.prompt,
      tags: chosen.tags,
      source: 'restored',
      inputHash: chosen.inputHash,
      analysisModel: chosen.analysisModel,
      createdBy: context.user.id,
    });
    return { variantId: inserted.id };
  });

const frameRegenerateInput = z.object({
  sequenceId: ulidSchema,
  shotId: ulidSchema,
  promptType: promptTypeSchema,
  // `force: true` bypasses the up-to-date short-circuit so the user can roll
  // the dice on a fresh non-deterministic LLM completion even when no upstream
  // inputs have changed. The staleness-banner path leaves this unset.
  force: z.boolean().optional(),
});

export const regenerateFramePromptFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameRegenerateInput))
  .handler(async ({ context, data }) => {
    const { shot: frame, sequence, scopedDb, user, teamId } = context;

    if (!frame.metadata) {
      throw new Error('Frame has no scene metadata to regenerate from');
    }

    const ctx = await loadFramePromptContext({
      scopedDb,
      sequence,
      scene: frame.metadata,
      // Motion prompts are conditioned on the rendered still (#929); feeding
      // its URL here keeps this regen-bail check in lockstep with the
      // generation-time stamp and the staleness verify. No-op for visual.
      startingFrameImageUrl: frame.thumbnailUrl,
    });

    // Bail if the cached input hash already matches the live recompute —
    // otherwise every double-click enqueues a duplicate workflow run and
    // appends a no-op `'regenerated'` history row. Hash inputs are narrowed
    // to what this frame's continuity actually references; the workflow
    // downstream still gets the full bibles for LLM context.
    //
    // `force` skips this bail so an explicit user click always reaches the
    // LLM — there's no other way to get a fresh non-deterministic completion
    // when upstream inputs are unchanged.
    const narrowed = narrowFramePromptContext(ctx);
    const liveHash =
      data.promptType === 'visual'
        ? await computeVisualPromptInputHash(narrowed)
        : await computeMotionPromptInputHash(narrowed);
    const storedHash =
      data.promptType === 'visual'
        ? frame.visualPromptInputHash
        : frame.motionPromptInputHash;
    if (!data.force && isPromptUpToDate(storedHash, liveHash)) {
      return { workflowRunId: null, alreadyUpToDate: true } as const;
    }

    // Stream incremental deltas only on the explicit force-regen path — the
    // user is actively watching the frame in that case. The auto-staleness
    // path can land later when the user isn't viewing this frame, so we skip
    // the realtime publishes to avoid burning Redis ops for a stream nobody
    // is consuming.
    const baseInput:
      | VisualPromptSceneWorkflowInput
      | MotionPromptSceneWorkflowInput = {
      userId: user.id,
      teamId,
      sequenceId: sequence.id,
      shotId: frame.id,
      scene: frame.metadata,
      aspectRatio: sequence.aspectRatio,
      characterBible: ctx.characterBible,
      locationBible: ctx.locationBible,
      elementBible: ctx.elementBible,
      styleConfig: ctx.styleConfig,
      analysisModelId:
        getAnalysisModelById(ctx.analysisModel)?.id ?? DEFAULT_ANALYSIS_MODEL,
      emitStreaming: data.force === true,
      // Snapshot the rendered still at trigger time (#929) — the motion
      // workflow must NOT look it up mid-run, or a concurrent re-render could
      // swap it. No-op for the visual path. `frame` was loaded at the top of
      // this handler, so this is the image as it exists right now.
      ...(data.promptType === 'motion' && {
        startingFrameImageUrl: frame.thumbnailUrl,
      }),
    };

    const urlPath =
      data.promptType === 'visual'
        ? '/visual-prompt-scene'
        : '/motion-prompt-scene';

    // Force-regen needs a unique dedup ID per click so QStash doesn't collapse
    // repeat clicks into a single run — the user is explicitly asking for
    // another LLM completion. The auto-staleness path keeps the stable
    // hash-based ID so genuine retries collapse to one run.
    const deduplicationId = data.force
      ? framePromptForceDedupId(
          data.promptType,
          frame.id,
          `${Date.now()}-${crypto.randomUUID()}`
        )
      : framePromptDedupId(data.promptType, frame.id, liveHash);

    const workflowRunId = await triggerWorkflow(urlPath, baseInput, {
      deduplicationId,
      label: buildWorkflowLabel(sequence.id),
    });

    return { workflowRunId, alreadyUpToDate: false } as const;
  });

const sequenceRegenerateInput = z.object({ sequenceId: ulidSchema });

export const regenerateMusicPromptFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(sequenceRegenerateInput))
  .handler(async ({ context }) => {
    const { sequence, scopedDb, user, teamId } = context;

    const frames = await scopedDb.shots.listBySequence(sequence.id);
    const scenes = frames
      .map((f) => f.metadata)
      .filter((m): m is NonNullable<typeof m> => m !== null);
    if (scenes.length === 0) {
      throw new Error(
        'Sequence has no scenes to regenerate the music prompt from'
      );
    }
    const sceneSummaries = buildMusicSceneSummaries(scenes);

    const analysisModelId =
      getAnalysisModelById(sequence.analysisModel)?.id ??
      DEFAULT_ANALYSIS_MODEL;

    // Bail if nothing has changed since the cached hash was written —
    // otherwise every double-click enqueues a duplicate workflow run.
    const liveHash = await computeMusicPromptInputHash({
      sceneSummaries,
      analysisModel: analysisModelId,
    });
    if (isPromptUpToDate(sequence.musicPromptInputHash, liveHash)) {
      return { workflowRunId: null, alreadyUpToDate: true } as const;
    }

    const workflowRunId = await triggerWorkflow<MusicPromptWorkflowInput>(
      '/music-prompt',
      {
        userId: user.id,
        teamId,
        sequenceId: sequence.id,
        sceneSummaries,
        analysisModelId,
      },
      {
        // Dedup by the live input hash so a QStash retry of the same upstream
        // context collapses to one workflow run instead of N.
        deduplicationId: musicPromptDedupId(sequence.id, liveHash),
        label: buildWorkflowLabel(sequence.id),
      }
    );

    return { workflowRunId, alreadyUpToDate: false } as const;
  });

export const getMusicPromptStalenessFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(sequenceListInput))
  .handler(async ({ context }) => {
    const { sequence, scopedDb } = context;

    // No stored hash: legacy sequence or never generated. Surface explicitly
    // so the UI can suppress the "regenerate" prompt without claiming
    // freshness.
    if (!sequence.musicPromptInputHash) {
      return { musicPrompt: 'untracked' as const };
    }

    try {
      const frames = await scopedDb.shots.listBySequence(sequence.id);
      const scenes = frames
        .map((f) => f.metadata)
        .filter((m): m is NonNullable<typeof m> => m !== null);
      if (scenes.length === 0) {
        return { musicPrompt: 'untracked' as const };
      }
      const sceneSummaries = buildMusicSceneSummaries(scenes);

      const latest = await scopedDb.sequenceMusicPromptVariants.getLatest(
        sequence.id
      );
      const analysisModel =
        latest?.analysisModel ??
        getAnalysisModelById(sequence.analysisModel)?.id ??
        DEFAULT_ANALYSIS_MODEL;

      const liveHash = await computeMusicPromptInputHash({
        sceneSummaries,
        analysisModel,
      });

      return {
        musicPrompt:
          liveHash !== sequence.musicPromptInputHash
            ? ('stale' as const)
            : ('fresh' as const),
      };
    } catch (error) {
      // Hash uncomputable (e.g., scene metadata missing a required field).
      // Surface as untracked so the UI doesn't lie about freshness.
      logger.warn(`uncomputable for sequence ${sequence.id}:`, { err: error });
      return { musicPrompt: 'untracked' as const };
    }
  });

// Variant `promptHash` is `simpleHash(text)` (32-bit, non-crypto). We match
// against prompt-variant rows that existed at or before the variant's
// `createdAt` to recover the prompt that produced it.
const variantPromptDiffInput = z.object({
  sequenceId: ulidSchema,
  variantId: ulidSchema,
});

export type VariantPromptDiff = {
  label: string;
  before: string;
  after: string;
} | null;

export const getDivergentVariantPromptDiffFn = createServerFn({
  method: 'GET',
})
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(variantPromptDiffInput))
  .handler(async ({ context, data }): Promise<VariantPromptDiff> => {
    const variant = await context.scopedDb.shotVariants.getById(data.variantId);
    if (!variant) return null;
    // Auth boundary: don't silently collapse cross-sequence access into a
    // 'no diff' return — that would mask an authorization bug.
    if (variant.sequenceId !== data.sequenceId) {
      throw new Error('Variant does not belong to this sequence');
    }
    // No diff to render: legacy variant without a prompt snapshot, or audio
    // variants which have no field-level prompt diff.
    if (!variant.promptHash) return null;
    if (variant.variantType === 'audio') return null;

    const promptType = variant.variantType === 'image' ? 'visual' : 'motion';
    const candidates =
      await context.scopedDb.shotPromptVariants.listCandidatesAtOrBefore(
        variant.shotId,
        promptType,
        variant.createdAt
      );

    const matched = candidates.find(
      (c) => simpleHash(c.text) === variant.promptHash
    );
    if (!matched) {
      // Hash chain broken — the prompt that produced this variant has been
      // pruned or never recorded. Log so operations notices history loss
      // instead of silently rendering an empty diff dialog.
      logger.warn(`no candidate prompt matched ${variant.id}`);
      return null;
    }

    const [frameRow] = await context.scopedDb.shots.getByIds([variant.shotId]);
    if (!frameRow) {
      // FK invariant violation — variant references a frame that no longer
      // exists.
      throw new Error(
        `Frame ${variant.shotId} missing for variant ${variant.id}`
      );
    }
    const live =
      promptType === 'visual' ? frameRow.imagePrompt : frameRow.motionPrompt;
    if (!live) return null;
    if (live === matched.text) return null;

    return {
      label: promptType === 'visual' ? 'Visual prompt' : 'Motion prompt',
      before: matched.text,
      after: live,
    };
  });
