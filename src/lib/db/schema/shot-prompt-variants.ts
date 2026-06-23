/**
 * Shot Prompt Variants Schema
 *
 * One row per revision of a shot's visual or motion prompt. The current
 * "active" prompt is mirrored on `shots.imagePrompt` / `shots.motionPrompt`
 * for read-path simplicity; this table stores the full revision history.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § prompt versioning.
 */

import type {
  MotionPromptComponents,
  MotionPromptParameters,
  VisualPromptComponents,
} from '@/lib/ai/scene-analysis.schema';
import { type InferSelectModel, sql } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { user } from './auth';
import { shots } from './shots';

/**
 * The shape of `components` depends on `promptType`:
 *   - `'visual'` rows store `VisualPromptComponents` (sceneDescription /
 *     subject / lighting / ...)
 *   - `'motion'` rows store `MotionPromptComponents` (cameraMovement /
 *     speed / ...)
 * User-edits without structured components persist `null`.
 */
export type ShotPromptVariantComponents =
  | VisualPromptComponents
  | MotionPromptComponents;

export const FRAME_PROMPT_TYPES = ['visual', 'motion'] as const;
export type FramePromptType = (typeof FRAME_PROMPT_TYPES)[number];

const PROMPT_VARIANT_SOURCES = [
  'ai-generated',
  'user-edit',
  'regenerated',
  'restored',
] as const;
export type PromptVariantSource = (typeof PROMPT_VARIANT_SOURCES)[number];

export const shotPromptVariants = snakeCase.table(
  'shot_prompt_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    shotId: text()
      .notNull()
      .references(() => shots.id, { onDelete: 'cascade' }),
    promptType: text().$type<FramePromptType>().notNull(),

    // Full prompt text (mirrors the cached column on `shots`).
    text: text().notNull(),
    // Structured prompt components (when available — visual prompts split into
    // composition / lighting / etc.; user-edits may not have components).
    components: text({
      mode: 'json',
    }).$type<ShotPromptVariantComponents>(),
    // Motion-only: timing / speed / camera parameters. Visual rows store null.
    parameters: text({
      mode: 'json',
    }).$type<MotionPromptParameters>(),

    source: text().$type<PromptVariantSource>().notNull(),

    // SHA-256 of the upstream context that produced an AI prompt; null for
    // user-edits since they have no upstream input surface.
    inputHash: text(),

    // Analysis model that produced the prompt (null for user-edits).
    analysisModel: text({ length: 100 }),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text().references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('idx_frame_prompt_variants_frame_type_created').on(
      table.shotId,
      table.promptType,
      table.createdAt
    ),
    // Idempotency: a workflow retry that re-emits the same AI prompt for the
    // same upstream context must not create a duplicate row. User-edits and
    // legacy rows have null `input_hash` and are excluded; `source = 'restored'`
    // is also excluded so a restore that carries forward an existing AI hash
    // still appends an audit row to history.
    uniqueIndex('uq_frame_prompt_variants_frame_type_hash_ai')
      .on(table.shotId, table.promptType, table.inputHash)
      .where(
        sql`${table.inputHash} IS NOT NULL AND ${table.source} != 'restored'`
      ),
  ]
);

export type ShotPromptVariant = InferSelectModel<typeof shotPromptVariants>;
