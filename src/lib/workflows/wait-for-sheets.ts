/**
 * Durable "wait for sheet generation" helpers for the matching workflows.
 *
 * When a user adds new talent or a new location while creating a sequence
 * (`TalentSuggestionSelector` → `createTalentFn`,
 * `LocationSuggestionSelector` → `createLibraryLocationFn`), the sheet /
 * reference-image generation runs in a *separate*, fire-and-forget workflow
 * (`/library-talent-sheet`, `/library-location-sheet`). The sequence's
 * `analyze-script-workflow` then spawns `talent-matching` / `location-matching`
 * which read those sheets:
 *
 *   - talent matching uses `talent.defaultSheet?.imageUrl` as the casting
 *     reference image, and
 *   - location matching SKIPS any library location without a
 *     `referenceImageUrl`.
 *
 * If the sheet workflow hasn't finished by the time matching reads the row, the
 * pre-cast talent gets an empty reference image (so the character no longer
 * looks like the chosen person) and the pre-selected location is dropped from
 * matching entirely. This helper closes that race by polling the DB in a
 * durable loop until every still-pending entity has its sheet — bounded by a
 * timeout so a sheet that failed to generate can't stall the whole pipeline.
 *
 * The poll uses `step.do` (durable, replay-safe) for each read and `step.sleep`
 * between reads, mirroring the batched-polling pattern in `motion-workflow.ts`.
 */

import type { ScopedDb } from '@/lib/db/scoped';
import { getLogger } from '@/lib/observability/logger';
import type { WorkflowSleepDuration, WorkflowStep } from 'cloudflare:workers';

const logger = getLogger(['openstory', 'workflow', 'wait-for-sheets']);

/** Read interval between durable poll attempts. */
const POLL_INTERVAL: WorkflowSleepDuration = '5 seconds';

/**
 * Max poll attempts. 36 × 5s ≈ 3 minutes — comfortably longer than a sheet
 * generation (image + headshot/preview, ~30-60s) but short enough that a
 * permanently-failed sheet only delays matching by a bounded amount before it
 * proceeds best-effort.
 */
const MAX_ATTEMPTS = 36;

export type WaitForSheetsResult = {
  /** True if every entity became ready before the timeout. */
  ready: boolean;
  /** Ids of entities still missing a sheet when the wait returned. */
  pendingIds: string[];
};

type PollArgs = {
  ids: string[];
  /** Prefix for the durable step names; must be unique within the workflow. */
  stepPrefix: string;
  /** Human-readable label for log lines. */
  label: string;
  /**
   * Returns the subset of `ids` that are NOT yet ready. Only entities the
   * scoped read actually returns are considered — an id the read doesn't return
   * (deleted, or another team's private row) is treated as "not pending" so we
   * never wait the full timeout for something matching will skip anyway.
   */
  findPending: () => Promise<string[]>;
};

async function pollUntilReady(
  step: WorkflowStep,
  { ids, stepPrefix, label, findPending }: PollArgs
): Promise<WaitForSheetsResult> {
  if (ids.length === 0) {
    return { ready: true, pendingIds: [] };
  }

  let pendingIds: string[] = ids;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    pendingIds = await step.do(`${stepPrefix}-check-${attempt}`, async () =>
      findPending()
    );

    if (pendingIds.length === 0) {
      return { ready: true, pendingIds: [] };
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      await step.sleep(`${stepPrefix}-wait-${attempt}`, POLL_INTERVAL);
    }
  }

  logger.warn(
    `[wait-for-sheets] Timed out waiting for ${label} after ${MAX_ATTEMPTS} attempts; proceeding with ${pendingIds.length} still pending`,
    { pendingIds }
  );
  return { ready: false, pendingIds };
}

/**
 * Block until every requested talent has a usable default sheet image, or the
 * timeout expires. Talent without a sheet (newly created, generation still in
 * flight) are polled; talent that already have one short-circuit on the first
 * read so existing/library talent add no latency.
 */
export async function waitForTalentSheets(
  step: WorkflowStep,
  scopedDb: ScopedDb,
  talentIds: string[]
): Promise<WaitForSheetsResult> {
  return pollUntilReady(step, {
    ids: talentIds,
    stepPrefix: 'wait-talent-sheets',
    label: 'talent sheets',
    findPending: async () => {
      const talent = await scopedDb.talent.getByIds(talentIds);
      return talent.filter((t) => !t.defaultSheet?.imageUrl).map((t) => t.id);
    },
  });
}

/**
 * Block until every requested library location has a reference image, or the
 * timeout expires. A location created with an uploaded reference image has one
 * immediately (short-circuit); one created from name/description only gets it
 * once `/library-location-sheet` finishes.
 */
export async function waitForLocationReferences(
  step: WorkflowStep,
  scopedDb: ScopedDb,
  locationIds: string[]
): Promise<WaitForSheetsResult> {
  return pollUntilReady(step, {
    ids: locationIds,
    stepPrefix: 'wait-location-refs',
    label: 'location references',
    findPending: async () => {
      const locations = await scopedDb.locations.getByIds(locationIds);
      return locations.filter((l) => !l.referenceImageUrl).map((l) => l.id);
    },
  });
}
