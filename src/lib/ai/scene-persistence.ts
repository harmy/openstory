/**
 * Scene-row persistence mapping (#908)
 * ============================================================================
 *
 * Maps an analysis `Scene` onto the scene-level columns of the `scenes` table
 * (#907). Scene-level shared truth — location, time of day, story beat, title,
 * continuity, music design, original script — lives on the scene row; the
 * shot's own `metadata` JSON keeps the full `Scene` object so existing read
 * paths are untouched.
 *
 * Pulled out of the workflow so the column mapping is unit-testable without a
 * full Cloudflare-Workflow harness.
 */

import type { NewScene } from '@/lib/db/schema';
import type { Scene } from './scene-analysis.schema';

/**
 * Build the `scenes` insert rows for a sequence from the ordered analysis
 * scenes. `orderIndex` is the scene's position in the analysis output (0-based),
 * which is the unique key the `scenes` table sorts and de-duplicates on.
 */
export function buildSceneInserts(
  sequenceId: string,
  scenes: ReadonlyArray<Scene>
): NewScene[] {
  return scenes.map((scene, index) => ({
    sequenceId,
    orderIndex: index,
    location: scene.metadata?.location ?? null,
    timeOfDay: scene.metadata?.timeOfDay ?? null,
    storyBeat: scene.metadata?.storyBeat ?? null,
    title: scene.metadata?.title ?? null,
    continuity: scene.continuity ?? null,
    musicDesign: scene.musicDesign ?? null,
    originalScript: scene.originalScript,
  }));
}
