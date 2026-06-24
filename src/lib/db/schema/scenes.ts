/**
 * Scenes Schema
 * Narrative units within a sequence — each owns an ordered list of shots,
 * a single look (image model) and a single motion character (video model).
 *
 * A scene is the render unit: capable models render all its shots in one
 * multi-shot call, others render N per-shot calls and attach the assets here.
 * Scene-level fields (location, time of day, story beat, continuity,
 * music design, original script) live in dedicated columns or typed JSON so
 * the shot's own `metadata` no longer has to be the sole source of truth.
 *
 * @see src/lib/ai/scene-analysis.schema.ts for the Scene metadata structure
 * @see src/lib/db/schema/shots.ts — shots reference a scene via `shots.sceneId`
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { sequences } from './sequences';

/**
 * Generation status values for the scene-level video render. Mirrors the
 * shot-level statuses (kept as a local list per the existing per-schema
 * convention rather than a shared import).
 */
const SCENE_GENERATION_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
type SceneGenerationStatus = (typeof SCENE_GENERATION_STATUSES)[number];

/**
 * Branded id for `scenes.id` (a ULID). Distinct from the LLM-assigned
 * `Scene.sceneId` string carried in analysis output (see `analysisSceneId` in
 * the ShotMapping type) — both are plain strings, so this brand exists for call
 * sites that want the compiler to keep the two apart. The `scenes.id` column is
 * `.$type<DbSceneId>()`, so `SceneRow.id` — and any relation query that reaches
 * a scene — carries the brand by inference. The scoped scene methods take it for
 * their id params, so a `scene.id` flows through naturally, while a bare
 * analysis `sceneId` string won't type-check where a `DbSceneId` is expected.
 */
export type DbSceneId = string & { readonly __brand: 'DbSceneId' };

/**
 * Brand a raw ULID string as a `DbSceneId` (no conversion, just a type cast).
 * The single sanctioned place to mint the brand — mirrors `micros()` in
 * billing/money.ts.
 */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- sole brand constructor for DbSceneId
export const dbSceneId = (id: string): DbSceneId => id as DbSceneId;

// Scene-level slices of the analysis `Scene` object, reused verbatim so the
// JSON columns stay precisely typed without re-declaring the shapes. All three
// columns are nullable (the backfill writes NULL for a null-metadata shot), so
// `| null` is spelled out — `originalScript` is a required field on `Scene`, so
// unlike the optional `continuity`/`musicDesign` it needs the explicit union.
type SceneContinuity = NonNullable<Scene['continuity']>;
type SceneMusicDesign = NonNullable<Scene['musicDesign']>;
type SceneOriginalScript = Scene['originalScript'] | null;

/**
 * Scenes table — narrative units within a sequence.
 */
export const scenes = snakeCase.table(
  'scenes',
  {
    id: text()
      .$defaultFn(() => generateId())
      .$type<DbSceneId>()
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    // 0-based scene order within the sequence.
    orderIndex: integer().notNull(),
    // Query/sort targets get dedicated columns (not buried in JSON).
    location: text(),
    timeOfDay: text(),
    storyBeat: text(),
    title: text(),
    // Typed JSON slices of the analysis Scene object.
    continuity: text({ mode: 'json' }).$type<SceneContinuity>(),
    musicDesign: text({ mode: 'json' }).$type<SceneMusicDesign>(),
    originalScript: text({ mode: 'json' }).$type<SceneOriginalScript>(),
    // Model selection lives at scene level (one look, one motion character).
    // NULL = inherit from the sequence default (#909 wires the UI later).
    imageModel: text({ length: 100 }),
    videoModel: text({ length: 100 }),
    // Scene-render video columns — unused until #910, included now to avoid a
    // later ALTER. All nullable.
    videoUrl: text(),
    videoPath: text(), // R2 storage path (not signed URL)
    videoStatus: text().$type<SceneGenerationStatus>().default('pending'),
    videoWorkflowRunId: text(),
    videoGeneratedAt: integer({ mode: 'timestamp' }),
    videoError: text(),
    videoInputHash: text(),
    // How the scene render is assembled (e.g. multi-shot vs per-shot). Free
    // text until #910 defines the strategy enum.
    renderStrategy: text(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_scenes_sequence_order').on(table.sequenceId, table.orderIndex),
    uniqueIndex('scenes_sequence_id_order_index_key').on(
      table.sequenceId,
      table.orderIndex
    ),
  ]
);

// `id` carries the `DbSceneId` brand via the column's `.$type<>()`, so the
// inferred models are branded directly — no Omit-and-re-add, and relation
// queries / the `shots.sceneId` FK pick the brand up for free.
export type SceneRow = InferSelectModel<typeof scenes>;
export type NewScene = InferInsertModel<typeof scenes>;
