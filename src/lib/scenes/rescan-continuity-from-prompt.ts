/**
 * Server helper: re-scan a (possibly user-edited) prompt for canonical
 * character / element / location tags and additively merge them into a
 * frame's `metadata.continuity`.
 *
 * Lives here — not inline in `updateShotFn` — because the auto-link feature
 * (#683) needs to fire from both the explicit save path AND the regenerate
 * paths (`generateShotImageFn`, `generateShotMotionFn`). In practice the
 * regenerate paths are the only ones the UI actually calls today, so without
 * this helper the auto-link is dead code.
 *
 * Pure with respect to the database: callers are responsible for persisting
 * the returned continuity if `changed === true`.
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import {
  extractContinuityFromPrompt,
  hasContinuityAdditions,
  mergeContinuityAdditions,
} from '@/lib/workflows/extract-continuity-from-prompt';

type Continuity = NonNullable<Scene['continuity']>;

export type ContinuityRescanResult = {
  continuity: Continuity;
  changed: boolean;
};

export async function rescanContinuityFromPrompt(args: {
  scopedDb: Pick<
    ScopedDb,
    'characters' | 'sequenceElements' | 'sequenceLocations'
  >;
  sequenceId: string;
  existing: Continuity;
  promptText: string;
}): Promise<ContinuityRescanResult> {
  const { scopedDb, sequenceId, existing, promptText } = args;

  if (!promptText.trim()) {
    return { continuity: existing, changed: false };
  }

  const [characters, elements, locations] = await Promise.all([
    scopedDb.characters.list(sequenceId),
    scopedDb.sequenceElements.list(sequenceId),
    scopedDb.sequenceLocations.list(sequenceId),
  ]);

  const additions = extractContinuityFromPrompt({
    promptText,
    characters,
    elements,
    locations,
    existing,
  });

  if (!hasContinuityAdditions(additions)) {
    return { continuity: existing, changed: false };
  }

  return {
    continuity: mergeContinuityAdditions(existing, additions),
    changed: true,
  };
}
