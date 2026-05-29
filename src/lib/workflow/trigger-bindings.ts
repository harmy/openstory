/**
 * Maps trigger paths (the URL fragment passed to `triggerWorkflow`) to the
 * env binding name declared in `wrangler.jsonc`. Every workflow is a
 * Cloudflare Workflow — `triggerWorkflow` resolves the binding here and calls
 * `binding.create()`.
 *
 * To add a new workflow:
 *   1. Add the `class_name` + `binding` to `wrangler.jsonc` under `workflows[]`
 *   2. Re-export the entrypoint class from `src/server.ts` so the bundler
 *      includes it.
 *   3. Add an entry here.
 */

import type { CloudflareEnv } from '@/lib/workflow/types';
import { buildInstanceId } from '@/lib/workflow/instance-id';

const TRIGGER_TO_BINDING: Record<string, keyof CloudflareEnv> = {
  image: 'IMAGE_WORKFLOW',
  'element-vision': 'ELEMENT_VISION_WORKFLOW',
  music: 'MUSIC_WORKFLOW',
  motion: 'MOTION_WORKFLOW',
  'motion-batch': 'MOTION_BATCH_WORKFLOW',
  'character-sheet': 'CHARACTER_SHEET_WORKFLOW',
  'location-sheet': 'LOCATION_SHEET_WORKFLOW',
  'library-talent-sheet': 'LIBRARY_TALENT_SHEET_WORKFLOW',
  'library-location-sheet': 'LIBRARY_LOCATION_SHEET_WORKFLOW',
  'variant-image': 'SHOT_VARIANT_WORKFLOW',
  'upscale-variant': 'UPSCALE_SHOT_VARIANT_WORKFLOW',
  'visual-prompt-scene': 'VISUAL_PROMPT_SCENE_WORKFLOW',
  'motion-prompt-scene': 'MOTION_PROMPT_SCENE_WORKFLOW',
  'music-prompt': 'MUSIC_PROMPT_WORKFLOW',
  'recast-character': 'RECAST_CHARACTER_WORKFLOW',
  'location-matching': 'LOCATION_MATCHING_WORKFLOW',
  'frame-images': 'FRAME_IMAGES_WORKFLOW',
  'talent-matching': 'TALENT_MATCHING_WORKFLOW',
  'character-sheet-from-bible': 'CHARACTER_BIBLE_WORKFLOW',
  'location-sheet-from-bible': 'LOCATION_BIBLE_WORKFLOW',
  'visual-prompts': 'VISUAL_PROMPT_WORKFLOW',
  'motion-prompts': 'MOTION_PROMPT_WORKFLOW',
  'motion-music-prompts': 'MOTION_MUSIC_PROMPTS_WORKFLOW',
  'regenerate-frames': 'REGENERATE_FRAMES_WORKFLOW',
  'recast-location': 'RECAST_LOCATION_WORKFLOW',
  'replace-element': 'REPLACE_ELEMENT_WORKFLOW',
  'scene-split': 'SCENE_SPLIT_WORKFLOW',
  storyboard: 'STORYBOARD_WORKFLOW',
  'analyze-script': 'ANALYZE_SCRIPT_WORKFLOW',
};

export type CfTriggerResult = { workflowRunId: string };

function normaliseTriggerPath(triggerPath: string): string {
  return triggerPath.startsWith('/') ? triggerPath.slice(1) : triggerPath;
}

function isWorkflowBinding(value: unknown): value is Workflow<unknown> {
  return typeof value === 'object' && value !== null && 'create' in value;
}

/**
 * Look up the CF binding for a trigger path. Throws when the path is unknown
 * or the binding is missing — both are deploy/config errors (a workflow with
 * no `wrangler.jsonc` entry, or `bun cf:typegen` not run), not runtime states
 * we should silently swallow.
 */
export function getCfBindingForTriggerPath(
  triggerPath: string,
  env: CloudflareEnv
): Workflow<unknown> {
  const key = normaliseTriggerPath(triggerPath);
  const bindingName = TRIGGER_TO_BINDING[key];
  if (!bindingName) {
    throw new Error(
      `[triggerWorkflow] no workflow binding mapped for trigger path '${key}'. Add it to TRIGGER_TO_BINDING in src/lib/workflow/trigger-bindings.ts.`
    );
  }
  const binding = env[bindingName];
  if (!isWorkflowBinding(binding)) {
    throw new Error(
      `[triggerWorkflow] binding '${String(bindingName)}' for '${key}' is missing or not a Workflow binding. ` +
        `Check wrangler.jsonc and ensure 'bun cf:typegen' has been run.`
    );
  }
  return binding;
}

/**
 * Resolve the CF binding for a stored workflow run id, used by the
 * reconciler to query instance status. Run ids built by `buildInstanceId`
 * have the shape `${envSlug}_${workflowName}_${suffix}` — the workflow name
 * is the second underscore-delimited segment. Returns null for ids that don't
 * map to a known workflow (e.g. legacy QStash run ids), so callers can treat
 * them as unresolvable.
 */
export function getCfBindingForRunId(
  runId: string,
  env: CloudflareEnv
): Workflow<unknown> | null {
  const segments = runId.split('_');
  const workflowName = segments[1];
  if (!workflowName) return null;
  const bindingName = TRIGGER_TO_BINDING[workflowName];
  if (!bindingName) return null;
  const binding = env[bindingName];
  return isWorkflowBinding(binding) ? binding : null;
}

/**
 * Trigger a workflow.
 */
export async function triggerCfWorkflow<T extends Rpc.Serializable<T>>({
  binding,
  triggerPath,
  body,
  env,
  deduplicationId,
}: {
  binding: Workflow<T>;
  triggerPath: string;
  body: T;
  env: CloudflareEnv;
  deduplicationId?: string;
}): Promise<CfTriggerResult> {
  const workflowName = normaliseTriggerPath(triggerPath);
  const id = buildInstanceId({
    env,
    workflowName,
    suffix: deduplicationId ?? `${Date.now()}-${crypto.randomUUID()}`,
  });

  const instance = await binding.create({ id, params: body });
  return { workflowRunId: instance.id };
}
