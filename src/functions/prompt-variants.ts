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
  type FramePromptVariant,
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

const promptTypeSchema = z.enum(FRAME_PROMPT_TYPES);

/**
 * Stable deduplication ID for frame-prompt regeneration. Workflow retries with
 * the same upstream context must collapse to a single run, so this string
 * cannot include timestamps or random suffixes.
 */
export function framePromptDedupId(
  promptType: 'visual' | 'motion',
  frameId: string,
  liveHash: string
): string {
  return `prompt-${promptType}-${frameId}-${liveHash}`;
}

/**
 * Unique deduplication ID for an explicit user-driven force-regeneration.
 * Distinct from `framePromptDedupId` because the user is asking for a fresh
 * LLM completion regardless of whether upstream inputs changed — collapsing
 * repeat clicks to one run would silently swallow the regeneration.
 */
export function framePromptForceDedupId(
  promptType: 'visual' | 'motion',
  frameId: string,
  nonce: string
): string {
  return `prompt-${promptType}-${frameId}-force-${nonce}`;
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

export type FramePromptVariantWithAuthor = FramePromptVariant & {
  createdByName: string | null;
};

export type SequenceMusicPromptVariantWithAuthor =
  SequenceMusicPromptVariant & { createdByName: string | null };

const frameListInput = z.object({
  sequenceId: ulidSchema,
  frameId: ulidSchema,
  promptType: promptTypeSchema,
});

export const listFramePromptVariantsFn = createServerFn({ method: 'GET' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameListInput))
  .handler(
    async ({ context, data }): Promise<FramePromptVariantWithAuthor[]> => {
      return await context.scopedDb.framePromptVariants.listByFrameWithAuthor(
        data.frameId,
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
  frameId: ulidSchema,
  variantId: ulidSchema,
});

export const restoreFramePromptVariantFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameRestoreInput))
  .handler(async ({ context, data }) => {
    const chosen = await context.scopedDb.framePromptVariants.getByIdForFrame(
      data.variantId,
      data.frameId
    );
    if (!chosen) {
      throw new Error('Prompt variant not found for this frame');
    }

    const inserted = await context.scopedDb.framePromptVariants.write({
      frameId: data.frameId,
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
  frameId: ulidSchema,
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
    const { frame, sequence, scopedDb, user, teamId } = context;

    if (!frame.metadata) {
      throw new Error('Frame has no scene metadata to regenerate from');
    }

    const ctx = await loadFramePromptContext({
      scopedDb,
      sequence,
      scene: frame.metadata,
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

    const baseInput:
      | VisualPromptSceneWorkflowInput
      | MotionPromptSceneWorkflowInput = {
      userId: user.id,
      teamId,
      sequenceId: sequence.id,
      frameId: frame.id,
      scene: frame.metadata,
      aspectRatio: sequence.aspectRatio,
      characterBible: ctx.characterBible,
      locationBible: ctx.locationBible,
      elementBible: ctx.elementBible,
      styleConfig: ctx.styleConfig,
      analysisModelId:
        getAnalysisModelById(ctx.analysisModel)?.id ?? DEFAULT_ANALYSIS_MODEL,
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

    const frames = await scopedDb.frames.listBySequence(sequence.id);
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
      const frames = await scopedDb.frames.listBySequence(sequence.id);
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
      console.warn(
        `[getMusicPromptStalenessFn] uncomputable for sequence ${sequence.id}:`,
        error
      );
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
    const variant = await context.scopedDb.frameVariants.getById(
      data.variantId
    );
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
      await context.scopedDb.framePromptVariants.listCandidatesAtOrBefore(
        variant.frameId,
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
      console.warn(
        `[getDivergentVariantPromptDiffFn] no candidate prompt matched ${variant.id}`
      );
      return null;
    }

    const [frameRow] = await context.scopedDb.frames.getByIds([
      variant.frameId,
    ]);
    if (!frameRow) {
      // FK invariant violation — variant references a frame that no longer
      // exists.
      throw new Error(
        `Frame ${variant.frameId} missing for variant ${variant.id}`
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
