/**
 * Fixed time estimates for generation phases based on scene count.
 * Used to show a countdown timer in the generation progress banner.
 */

const PHASE_BUDGETS = [
  { base: 30, perScene: 1.5 }, // 1. Script analysis (streaming LLM output scales with scenes)
  { base: 60, perScene: 1.5 }, // 2. Casting (LLM input scales with scenes)
  { base: 150, perScene: 0 }, // 3. Sheets + visual prompts (all parallel per scene)
  { base: 90, perScene: 0 }, // 4. Images + motion/music prompts (all parallel per scene)
  { base: 210, perScene: 0 }, // 5. Motion/music generation (optional; all parallel per scene)
] as const;

const WORDS_PER_SCENE = 120;
const MIN_SCENES = 1;
const MAX_SCENES = 30;
const DEFAULT_SCENE_COUNT = 6;

export function estimateSceneCount(script: string): number {
  const wordCount = script.trim().split(/\s+/).filter(Boolean).length;
  const estimated = Math.round(wordCount / WORDS_PER_SCENE);
  return Math.max(MIN_SCENES, Math.min(MAX_SCENES, estimated));
}

function phaseBudget(phaseIndex: number, sceneCount: number): number {
  const budget = PHASE_BUDGETS[phaseIndex];
  return budget.base + budget.perScene * sceneCount;
}

export function estimateTotalSeconds(
  sceneCount: number,
  estimatedSceneCount?: number,
  phaseCount: number = PHASE_BUDGETS.length
): number {
  const fallback = estimatedSceneCount ?? DEFAULT_SCENE_COUNT;
  const scenes = sceneCount > 0 ? sceneCount : fallback;
  let total = 0;
  for (let i = 0; i < Math.min(phaseCount, PHASE_BUDGETS.length); i++) {
    const b = PHASE_BUDGETS[i];
    total += b.base + b.perScene * scenes;
  }
  return total;
}

export function estimateRemainingSeconds(opts: {
  sceneCount: number;
  completedPhases: number[];
  elapsedSeconds: number;
  estimatedSceneCount?: number;
}): number {
  const fallback = opts.estimatedSceneCount ?? DEFAULT_SCENE_COUNT;
  const scenes = opts.sceneCount > 0 ? opts.sceneCount : fallback;
  const completedSet = new Set(opts.completedPhases);

  let remaining = 0;
  for (let i = 0; i < PHASE_BUDGETS.length; i++) {
    const phaseNumber = i + 1;
    if (!completedSet.has(phaseNumber)) {
      remaining += phaseBudget(i, scenes);
    }
  }

  return Math.max(0, remaining);
}

export function formatTimeRemaining(seconds: number): string {
  if (seconds <= 0) return 'Finishing up\u2026';
  if (seconds < 60) return `${seconds}s remaining`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  const paddedSecs = secs.toString().padStart(2, '0');
  return `${minutes}:${paddedSecs} remaining`;
}
