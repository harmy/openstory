/**
 * Asset generation workflow (#458 — direct model access).
 *
 * Runs an ARBITRARY fal endpoint (validated + credit-gated upstream in
 * `createGeneratedAssetFn`) and lands the outputs as a flat team asset:
 *
 *   1. set-running — flips the reserved `generated_assets` row to 'running'.
 *   2. submit-asset-job — submits to the fal queue (raw `@fal-ai/client`
 *      queue API: arbitrary endpoints have no typed @tanstack/ai-fal adapter).
 *   3. asset-poll-batch-N — batched polling like the motion workflow: a tight
 *      ~30s loop inside each step, checkpoint between batches.
 *   4. fetch-result — pulls the queue result and scans it for output files.
 *   5. upload-outputs — uploads each output to R2; stored URLs are
 *      origin-relative `/r2/<key>` (#894).
 *   6. persist-result — flips the row to 'completed' with the outputs.
 *
 * BYOK follows the house pattern (`scopedDb.apiKeys.resolveKey('fal')`,
 * platform key fallback), applied to the `fal` singleton via `fal.config` —
 * the same singleton the base class routes through the e2e proxy. No credit
 * deduction happens here: the raw queue API doesn't surface `unitsBilled`
 * and `FAL_PRICING` has no data for arbitrary endpoints, so per the house
 * billing rule we charge nothing rather than guess (`costMicros` stays null).
 */

import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import type { ScopedDb } from '@/lib/db/scoped';
import type {
  GeneratedAssetActivity,
  GeneratedAssetOutput,
  JsonValue,
} from '@/lib/db/schema';
import { getLogger } from '@/lib/observability/logger';
import { STORAGE_BUCKETS, type StorageBucket } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import type { AssetGenerationWorkflowInput } from '@/lib/workflow/types';
import { fal } from '@fal-ai/client';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

const logger = getLogger(['openstory', 'workflow', 'asset']);

/** Each batch polls in a tight loop for ~30s, then checkpoints for durability */
const POLL_BATCH_DURATION_MS = 30_000;
const POLL_INTERVAL_MS = 3_000;
/** 60 batches × 30s = 30 minutes — matches the motion workflow's budget,
 *  which absorbs provider-side queueing for slow video models. */
const MAX_BATCHES = 60;

/** R2 bucket per activity — assets reuse the existing media buckets. */
const ACTIVITY_BUCKETS: Record<GeneratedAssetActivity, StorageBucket> = {
  image: STORAGE_BUCKETS.THUMBNAILS,
  video: STORAGE_BUCKETS.VIDEOS,
  audio: STORAGE_BUCKETS.AUDIO,
};

/** One provider-hosted output file found in a fal queue result. */
export type AssetOutputRef = {
  url: string;
  /** fal file objects carry `content_type`; null when only a bare URL. */
  contentType: string | null;
};

/** A fal file object (`{ url, content_type, … }`) or a bare URL string. */
function toOutputRef(value: JsonValue): AssetOutputRef | null {
  if (typeof value === 'string') {
    return value.startsWith('http') ? { url: value, contentType: null } : null;
  }
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    const url = value.url;
    if (typeof url !== 'string') return null;
    const contentType = value.content_type;
    return {
      url,
      contentType: typeof contentType === 'string' ? contentType : null,
    };
  }
  return null;
}

/** Result fields that carry media files across fal endpoints. */
const OUTPUT_FIELDS = [
  'images',
  'image',
  'videos',
  'video',
  'audios',
  'audio',
  'audio_file',
  'outputs',
  'output',
] as const;

/**
 * Scan a fal queue result for output media files. fal output schemas vary per
 * endpoint but converge on a handful of field names holding either a file
 * object (`{ url, content_type }`), a bare URL string, or an array of either
 * — collect them all, in field order.
 */
export function extractAssetOutputs(data: JsonValue): AssetOutputRef[] {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return [];
  }
  const refs: AssetOutputRef[] = [];
  for (const field of OUTPUT_FIELDS) {
    const value = data[field];
    if (value === undefined) continue;
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      const ref = toOutputRef(candidate);
      if (ref) refs.push(ref);
    }
  }
  return refs;
}

/** The row writes this workflow needs — a narrow slice of {@link ScopedDb}
 * so unit tests can inject a small spy. */
export type AssetPersistScopedDb = {
  generatedAssets: {
    markRunning: (id: string) => Promise<void>;
    markCompleted: (
      id: string,
      fields: { outputs: GeneratedAssetOutput[]; costMicros?: number | null }
    ) => Promise<void>;
    markFailed: (id: string, error: string) => Promise<void>;
  };
};

/**
 * Resolve the fal key (BYOK via team key, platform fallback) and apply it to
 * the `fal` singleton — the same singleton `configureFalProxyFromEnv` routes
 * through the e2e proxy, and the same `fal.config({ credentials })` call the
 * @tanstack/ai-fal adapters make. Called inside every step that talks to fal,
 * since a replayed step may run in a fresh isolate.
 */
async function configureFalForTeam(scopedDb: ScopedDb): Promise<void> {
  const keyInfo = await scopedDb.apiKeys.resolveKey('fal');
  fal.config({ credentials: keyInfo.key });
}

export class AssetGenerationWorkflow extends OpenStoryWorkflowEntrypoint<AssetGenerationWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<AssetGenerationWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<{ assetId: string; outputs: GeneratedAssetOutput[] }> {
    const { assetId, endpointId, activity, input, teamId } = event.payload;

    await step.do('set-running', async () => {
      await scopedDb.generatedAssets.markRunning(assetId);
    });

    // Submit to the fal queue. A 422 is a payload the endpoint rejected —
    // retrying the same input can't succeed, so fail immediately; anything
    // else is transient and leans on CF's per-step retries.
    const { requestId } = await step.do('submit-asset-job', async () => {
      await configureFalForTeam(scopedDb);
      logger.info(
        `[AssetGenerationWorkflow] Submitting ${endpointId} (${activity}) for asset ${assetId}`
      );
      try {
        const { request_id } = await fal.queue.submit(endpointId, { input });
        return { requestId: request_id };
      } catch (error) {
        if (
          error instanceof Error &&
          'status' in error &&
          error.status === 422
        ) {
          throw new NonRetryableError(
            `Model rejected the input (422): ${extractFalErrorMessage(error)}`
          );
        }
        throw error;
      }
    });

    // Batched polling — tight loop inside each step.do, checkpoint between
    // batches (same shape as the motion workflow). The fal queue reports
    // IN_QUEUE / IN_PROGRESS / COMPLETED; failures surface on fetch-result.
    let completed = false;
    for (let batch = 0; batch < MAX_BATCHES && !completed; batch++) {
      if (batch > 0) {
        await step.sleep(`asset-poll-wait-${batch}`, 1);
      }
      completed = await step.do(`asset-poll-batch-${batch}`, async () => {
        await configureFalForTeam(scopedDb);
        const deadline = Date.now() + POLL_BATCH_DURATION_MS;
        while (Date.now() < deadline) {
          const status = await fal.queue.status(endpointId, {
            requestId,
            logs: false,
          });
          if (status.status === 'COMPLETED') return true;
          await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        return false;
      });
    }
    if (!completed) {
      throw new Error(
        `Asset generation timed out after ${(MAX_BATCHES * POLL_BATCH_DURATION_MS) / 60_000} minutes`
      );
    }

    // Fetch the result. A failed fal job rejects here with the real error —
    // deterministic, so don't burn CF retries on it.
    const outputRefs = await step.do('fetch-result', async () => {
      await configureFalForTeam(scopedDb);
      let data: JsonValue;
      try {
        const result = await fal.queue.result(endpointId, { requestId });
        data = result.data;
      } catch (error) {
        throw new NonRetryableError(
          `Model run failed: ${extractFalErrorMessage(error)}`
        );
      }
      const refs = extractAssetOutputs(data);
      if (refs.length === 0) {
        throw new NonRetryableError(
          `Model returned no output files for ${endpointId}`
        );
      }
      return refs;
    });

    const outputs = await step.do('upload-outputs', async () => {
      const uploaded: GeneratedAssetOutput[] = [];
      for (const [index, ref] of outputRefs.entries()) {
        const response = await fetch(ref.url);
        if (!response.ok) {
          throw new Error(
            `Failed to download output ${index} from provider: ${response.status}`
          );
        }
        const extension = getExtensionFromUrl(ref.url);
        const contentType =
          ref.contentType ??
          response.headers.get('content-type') ??
          getMimeTypeFromExtension(extension);
        const path = `teams/${teamId}/assets/${assetId}/output-${index}.${extension}`;
        const result = await uploadResponse(
          response,
          ACTIVITY_BUCKETS[activity],
          path,
          { contentType }
        );
        uploaded.push({ url: result.publicUrl, contentType });
      }
      return uploaded;
    });

    await step.do('persist-result', async () => {
      await persistAssetCompletion({
        scopedDb,
        assetId,
        outputs,
      });
    });

    logger.info(
      `[AssetGenerationWorkflow] Completed asset ${assetId} (${outputs.length} output${outputs.length === 1 ? '' : 's'})`
    );
    return { assetId, outputs };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<AssetGenerationWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    await persistAssetFailure({
      scopedDb,
      assetId: event.payload.assetId,
      error,
    });
    logger.error(
      `[AssetGenerationWorkflow] Asset ${event.payload.assetId} failed: ${error}`
    );
  }
}

/** Flip the row to `completed` with its uploaded outputs (`error` cleared). */
export async function persistAssetCompletion(params: {
  scopedDb: AssetPersistScopedDb;
  assetId: string;
  outputs: GeneratedAssetOutput[];
}): Promise<void> {
  await params.scopedDb.generatedAssets.markCompleted(params.assetId, {
    outputs: params.outputs,
    costMicros: null,
  });
}

/** Flip the row to `failed` with the sanitized error message. */
export async function persistAssetFailure(params: {
  scopedDb: AssetPersistScopedDb;
  assetId: string;
  error: string;
}): Promise<void> {
  await params.scopedDb.generatedAssets.markFailed(
    params.assetId,
    params.error
  );
}
