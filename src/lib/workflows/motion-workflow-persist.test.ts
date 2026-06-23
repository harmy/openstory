/**
 * Behavioural tests for the motion-workflow dual-write helpers (#545).
 *
 * `MotionWorkflow` writes each model's output to the legacy `shots.video*`
 * columns AND a per-model `shot_variants` row. These tests pin the three
 * states the workflow transitions through:
 *
 *   - generating: open the variant row + stamp the legacy columns
 *   - completed:  stamp both, clearing any prior error (shot-deleted short-circuit)
 *   - failed:     record the error on both — updating the existing variant row
 *                 (preserving a completed url), falling back to UPSERT only when
 *                 no row exists so a pre-generating failure still lands a row
 */

import { describe, expect, it } from 'vitest';
import type { NewShot, NewShotVariant } from '@/lib/db/schema';
import type { VariantType } from '@/lib/db/schema/shot-variants';
import {
  buildMotionCompletedWrites,
  buildMotionFailedWrites,
  buildMotionGeneratingWrites,
  type MotionVideoProgressPayload,
  persistMotionCompletion,
  persistMotionFailure,
  type PersistMotionScopedDb,
} from './motion-workflow-persist';

const upload = {
  url: 'https://r2/seq/shot-veo.mp4',
  path: 'team/seq/shot.mp4',
};
const NOW = new Date('2026-06-02T00:00:00Z');

describe('buildMotionGeneratingWrites', () => {
  it('stamps the legacy columns with the model + run id and opens the variant row', () => {
    const writes = buildMotionGeneratingWrites({
      model: 'veo3',
      workflowRunId: 'run-1',
    });
    expect(writes.shot).toEqual({
      videoStatus: 'generating',
      videoWorkflowRunId: 'run-1',
      motionModel: 'veo3',
    });
    expect(writes.variant).toEqual({
      status: 'generating',
      workflowRunId: 'run-1',
    });
  });
});

describe('buildMotionCompletedWrites', () => {
  it('stamps the final video on both the shot and the variant and clears errors', () => {
    const writes = buildMotionCompletedWrites({
      upload,
      durationMs: 5000,
      promptHash: 'prompt-abc',
      generatedAt: NOW,
    });
    expect(writes.shot).toEqual({
      videoPath: upload.path,
      videoUrl: upload.url,
      durationMs: 5000,
      videoStatus: 'completed',
      videoGeneratedAt: NOW,
      videoError: null,
    });
    expect(writes.variant).toEqual({
      url: upload.url,
      storagePath: upload.path,
      status: 'completed',
      generatedAt: NOW,
      error: null,
      durationMs: 5000,
      promptHash: 'prompt-abc',
    });
  });

  it('carries a null promptHash through unchanged', () => {
    const writes = buildMotionCompletedWrites({
      upload,
      durationMs: 5000,
      promptHash: null,
      generatedAt: NOW,
    });
    expect(writes.variant.promptHash).toBeNull();
  });
});

describe('buildMotionFailedWrites', () => {
  it('records the error on both the shot and the variant', () => {
    const writes = buildMotionFailedWrites({ error: 'fal 500' });
    expect(writes.shot).toEqual({
      videoStatus: 'failed',
      videoError: 'fal 500',
    });
    expect(writes.variant).toEqual({ status: 'failed', error: 'fal 500' });
  });
});

type ShotUpdateCall = { shotId: string; data: Partial<NewShot> };
type VariantUpdateCall = {
  shotId: string;
  variantType: VariantType;
  model: string;
  data: Partial<NewShotVariant>;
};
type CallName =
  | 'shots.update'
  | 'shotVariants.updateByShotAndModel'
  | 'shotVariants.upsert';

function buildScopedDbSpy(
  opts: { shotMissing?: boolean; variantMissing?: boolean } = {}
): {
  scopedDb: PersistMotionScopedDb;
  shotsUpdates: ShotUpdateCall[];
  variantsUpdates: VariantUpdateCall[];
  variantsUpserts: NewShotVariant[];
  callOrder: CallName[];
} {
  const shotsUpdates: ShotUpdateCall[] = [];
  const variantsUpdates: VariantUpdateCall[] = [];
  const variantsUpserts: NewShotVariant[] = [];
  const callOrder: CallName[] = [];
  const scopedDb: PersistMotionScopedDb = {
    shots: {
      update: async (shotId, data) => {
        shotsUpdates.push({ shotId, data });
        callOrder.push('shots.update');
        if (opts.shotMissing) return undefined;
        return { id: shotId };
      },
    },
    shotVariants: {
      updateByShotAndModel: async (shotId, variantType, model, data) => {
        variantsUpdates.push({ shotId, variantType, model, data });
        callOrder.push('shotVariants.updateByShotAndModel');
        // null = no matching primary row exists (caller decides whether to insert).
        return opts.variantMissing ? null : { id: 'v1' };
      },
      upsert: async (data) => {
        variantsUpserts.push(data);
        callOrder.push('shotVariants.upsert');
        return { id: 'v2' };
      },
    },
  };
  return {
    scopedDb,
    shotsUpdates,
    variantsUpdates,
    variantsUpserts,
    callOrder,
  };
}

describe('persistMotionCompletion', () => {
  it('stamps the legacy columns + this model variant, emits completed, returns the url', async () => {
    const { scopedDb, shotsUpdates, variantsUpdates, callOrder } =
      buildScopedDbSpy();
    const emits: Array<{ event: string; payload: MotionVideoProgressPayload }> =
      [];

    const outcome = await persistMotionCompletion({
      scopedDb,
      shotId: 'f1',
      model: 'veo3',
      upload,
      durationMs: 5000,
      promptHash: 'prompt-abc',
      emit: async (event, payload) => {
        emits.push({ event, payload });
      },
      now: () => NOW,
    });

    expect(outcome).toEqual({ status: 'completed', videoUrl: upload.url });
    expect(callOrder).toEqual([
      'shots.update',
      'shotVariants.updateByShotAndModel',
    ]);

    const [shotUpdate] = shotsUpdates;
    if (!shotUpdate) throw new Error('expected shots.update call');
    expect(shotUpdate.data.videoStatus).toBe('completed');
    expect(shotUpdate.data.videoUrl).toBe(upload.url);
    expect(shotUpdate.data.videoError).toBeNull();

    const [variantUpdate] = variantsUpdates;
    if (!variantUpdate) throw new Error('expected variant update call');
    expect(variantUpdate.shotId).toBe('f1');
    expect(variantUpdate.variantType).toBe('video');
    expect(variantUpdate.model).toBe('veo3');
    expect(variantUpdate.data.status).toBe('completed');
    expect(variantUpdate.data.url).toBe(upload.url);

    expect(emits).toEqual([
      {
        event: 'generation.video:progress',
        payload: {
          shotId: 'f1',
          status: 'completed',
          videoUrl: upload.url,
          model: 'veo3',
        },
      },
    ]);
  });

  it('shot deleted mid-flight: short-circuits without touching shot_variants or emitting', async () => {
    const { scopedDb, shotsUpdates, variantsUpdates, callOrder } =
      buildScopedDbSpy({ shotMissing: true });
    const emits: MotionVideoProgressPayload[] = [];

    const outcome = await persistMotionCompletion({
      scopedDb,
      shotId: 'f1',
      model: 'veo3',
      upload,
      durationMs: 5000,
      promptHash: null,
      emit: async (_event, payload) => {
        emits.push(payload);
      },
      now: () => NOW,
    });

    expect(outcome).toEqual({ status: 'shot-deleted' });
    expect(shotsUpdates.length).toBe(1);
    expect(variantsUpdates).toEqual([]);
    expect(emits).toEqual([]);
    expect(callOrder).toEqual(['shots.update']);
  });
});

describe('persistMotionFailure', () => {
  it('updates the existing variant row to failed (preserving its url, no upsert), then emits', async () => {
    const {
      scopedDb,
      shotsUpdates,
      variantsUpdates,
      variantsUpserts,
      callOrder,
    } = buildScopedDbSpy();
    const emits: Array<{ event: string; payload: MotionVideoProgressPayload }> =
      [];

    await persistMotionFailure({
      scopedDb,
      shotId: 'f1',
      sequenceId: 'seq1',
      model: 'veo3',
      error: 'fal 500',
      workflowRunId: 'run-9',
      emit: async (event, payload) => {
        emits.push({ event, payload });
      },
    });

    // A row exists: update only (status/error). No upsert — a blind upsert
    // would null the completed url/storagePath from the failure payload.
    expect(callOrder).toEqual([
      'shots.update',
      'shotVariants.updateByShotAndModel',
    ]);
    expect(variantsUpserts).toEqual([]);

    const [shotUpdate] = shotsUpdates;
    if (!shotUpdate) throw new Error('expected shots.update call');
    expect(shotUpdate.data.videoStatus).toBe('failed');
    expect(shotUpdate.data.videoError).toBe('fal 500');

    const [variantUpdate] = variantsUpdates;
    if (!variantUpdate) throw new Error('expected variant update call');
    expect(variantUpdate.shotId).toBe('f1');
    expect(variantUpdate.variantType).toBe('video');
    expect(variantUpdate.model).toBe('veo3');
    expect(variantUpdate.data).toEqual({ status: 'failed', error: 'fal 500' });
    // The update payload carries no url/storagePath, so an existing completed
    // artifact is left untouched.
    expect(variantUpdate.data.url).toBeUndefined();
    expect(variantUpdate.data.storagePath).toBeUndefined();

    expect(emits).toEqual([
      {
        event: 'generation.video:progress',
        payload: {
          shotId: 'f1',
          status: 'failed',
          model: 'veo3',
          // #881: the reason is now carried so the cache updater writes
          // `videoError` live (non-variant path).
          error: 'fal 500',
        },
      },
    ]);
  });

  it('no existing variant row (pre-generating failure): UPSERTS a failed row so it stays visible', async () => {
    const { scopedDb, variantsUpdates, variantsUpserts, callOrder } =
      buildScopedDbSpy({ variantMissing: true });

    await persistMotionFailure({
      scopedDb,
      shotId: 'f1',
      sequenceId: 'seq1',
      model: 'veo3',
      error: 'Insufficient credits for motion generation',
      workflowRunId: 'run-9',
      emit: async () => {},
    });

    // Update first (no-op, returns null), then upsert to land a visible row.
    expect(callOrder).toEqual([
      'shots.update',
      'shotVariants.updateByShotAndModel',
      'shotVariants.upsert',
    ]);
    expect(variantsUpdates.length).toBe(1);

    const [upserted] = variantsUpserts;
    if (!upserted) throw new Error('expected shotVariants.upsert call');
    expect(upserted).toMatchObject({
      shotId: 'f1',
      sequenceId: 'seq1',
      variantType: 'video',
      model: 'veo3',
      status: 'failed',
      error: 'Insufficient credits for motion generation',
      workflowRunId: 'run-9',
    });
  });
});

describe('variant-only (#547)', () => {
  it('persistMotionCompletion: writes only the variant row, never the legacy shots.video* columns', async () => {
    const { scopedDb, shotsUpdates, variantsUpdates, callOrder } =
      buildScopedDbSpy();
    const emits: MotionVideoProgressPayload[] = [];

    const outcome = await persistMotionCompletion({
      scopedDb,
      shotId: 'f1',
      model: 'veo3',
      upload,
      durationMs: 5000,
      promptHash: 'prompt-abc',
      variantOnly: true,
      emit: async (_event, payload) => {
        emits.push(payload);
      },
      now: () => NOW,
    });

    expect(outcome).toEqual({ status: 'completed', videoUrl: upload.url });
    // The primary columns are untouched — only the per-model variant is written.
    expect(shotsUpdates).toEqual([]);
    expect(callOrder).toEqual(['shotVariants.updateByShotAndModel']);
    const [variantUpdate] = variantsUpdates;
    if (!variantUpdate) throw new Error('expected variant update call');
    expect(variantUpdate.data.url).toBe(upload.url);
    expect(variantUpdate.data.status).toBe('completed');
    expect(emits).toEqual([
      {
        shotId: 'f1',
        status: 'completed',
        videoUrl: upload.url,
        model: 'veo3',
        // Flags the cache updater not to repoint the primary video (#547).
        variantOnly: true,
      },
    ]);
  });

  it('persistMotionCompletion: variant-only shot-deleted (no variant row) short-circuits without emitting', async () => {
    const { scopedDb, shotsUpdates, callOrder } = buildScopedDbSpy({
      variantMissing: true,
    });
    const emits: MotionVideoProgressPayload[] = [];

    const outcome = await persistMotionCompletion({
      scopedDb,
      shotId: 'f1',
      model: 'veo3',
      upload,
      durationMs: 5000,
      promptHash: null,
      variantOnly: true,
      emit: async (_event, payload) => {
        emits.push(payload);
      },
      now: () => NOW,
    });

    expect(outcome).toEqual({ status: 'shot-deleted' });
    expect(shotsUpdates).toEqual([]);
    expect(callOrder).toEqual(['shotVariants.updateByShotAndModel']);
    expect(emits).toEqual([]);
  });

  it('persistMotionFailure: records failed only on the variant, never the legacy columns', async () => {
    const { scopedDb, shotsUpdates, variantsUpdates, callOrder } =
      buildScopedDbSpy();

    await persistMotionFailure({
      scopedDb,
      shotId: 'f1',
      sequenceId: 'seq1',
      model: 'veo3',
      error: 'fal 500',
      workflowRunId: 'run-9',
      variantOnly: true,
      emit: async () => {},
    });

    expect(shotsUpdates).toEqual([]);
    expect(callOrder).toEqual(['shotVariants.updateByShotAndModel']);
    const [variantUpdate] = variantsUpdates;
    if (!variantUpdate) throw new Error('expected variant update call');
    expect(variantUpdate.data).toEqual({ status: 'failed', error: 'fal 500' });
  });
});
