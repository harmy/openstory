# Workflow snapshots and content-hash staleness

This is the companion to [managing-complex-dependency-graphs-in-collaborative-ai-video-platforms.md](./managing-complex-dependency-graphs-in-collaborative-ai-video-platforms.md). The original doc proposed a general-purpose versioned-DAG architecture with branching, XState lifecycles, Inngest, Postgres MVCC, Redis pub/sub, and Linear-style transaction sync. A review against the codebase shows that most of that infrastructure is already solved differently on our stack (Cloudflare Workflows, Durable Object-backed SSE realtime, Cloudflare D1, Drizzle, and scoped DB access from workflow payload `teamId`/`userId`) — and most of what remains unsolved reduces to a critical path of three ideas. This doc is the stack-specific subset we intend to ship.

It composes with [scoped-db-context-implementation.md](./scoped-db-context-implementation.md); every new data-access path described here flows through `ScopedDb`.

## The two failure modes we're closing

**1. Lost-work mid-generation.** Content-generation workflows must not read mutable DB state for anything that should be frozen at trigger time. Before the snapshot pattern, `regenerateShotsWorkflow` (`RegenerateShotsWorkflow` in `src/lib/workflows/regenerate-shots-workflow.ts`) could re-resolve sequence fields or sheet references mid-flight. If a user edits a character, location, or prompt while the workflow is running, generation can read a mix of pre- and post-edit inputs. The result is written as the primary artifact either way, with no signal that what landed isn't what the user had in mind when they triggered the workflow. `RegenerateShotsWorkflow` is the reference fix: it inlines per-shot snapshot DTOs and a batch `snapshotInputHash` at trigger time via `src/lib/workflows/regenerate-shots-snapshot.ts`.

**2. Silent staleness.** After a character recast or location swap, downstream frames, character sheets, location sheets, and talent sheets still display their prior outputs. Nothing in the schema records which inputs those outputs were derived from, so the UI can't distinguish "still current" from "stale but not yet regenerated" — and neither can a workflow about to apply a new result.

Both failure modes collapse into one missing primitive: **every generated artifact needs to remember the inputs it was generated from**, and every workflow needs to **freeze those inputs at start time and verify them at write time**.

## What we're explicitly not doing

Before describing the design, it's worth stating what the original doc recommended that we're skipping, and why — so future implementers don't accidentally drift back toward it:

| Original recommendation           | Why we skip it                                                                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Inngest for orchestration         | Cloudflare Workflows is already wired, and `OpenStoryWorkflowEntrypoint` (`src/lib/workflow/base-workflow.ts`) enforces `teamId`/`userId` on every run. Swapping orchestrators would be pure churn.                                     |
| XState v5 lifecycle machines      | Status columns (`thumbnailStatus`, `variantImageStatus`, `videoStatus`, `audioStatus`, `sequences.status`) already model `pending → generating → completed → failed`. Adding XState on top would duplicate state, not replace it.       |
| Custom Redis pub/sub + PG NOTIFY  | `src/lib/realtime/index.ts` already provides a typed `realtimeSchema`; delivery runs through the in-repo SSE client and `RealtimeChannel` Durable Object. We extend this schema, we don't replace it.                                   |
| Postgres JSONB / SKIP LOCKED      | The app runs on Cloudflare D1 (SQLite). Cloudflare Workflows is already the durable job engine; we don't need a DB-level queue at all.                                                                                                  |
| Entity version chains / branching | `frame_variants` (`src/lib/db/schema/frame-variants.ts`) already holds alternate per-model outputs, which covers the realistic "keep old vs new" use case for frame artifacts. General-purpose branching adds complexity we don't need. |
| Property-level LWW + rebasing     | We are not a concurrent editor. TanStack Query + server functions give us implicit last-writer-wins at the server boundary.                                                                                                             |
| Dependency edge table (v1)        | Character/location → shot linkage is inferred at runtime via `characterTags` in shot metadata and `matchCharactersToScene` (`src/lib/workflows/scene-matching.ts`). Good enough until we have a reason to materialize it.               |
| `stale` status enum value (v1)    | Staleness is a **derived** boolean (`generatedFromInputHash !== computeInputHash(entity)`). Adding it to the enum is a v2 question if the derived form ever proves insufficient.                                                        |

## Pillar 1: Input-hash staleness

Every artifact-bearing row stores the SHA-256 hash of the canonical serialization of the inputs used to generate it. Staleness is a query-time comparison, not a stored flag.

### What goes into the hash

The rule is: anything that, if changed, should cause the user to see a "regenerate" affordance. For our artifacts this is:

- **Frame image/variant** — the composed visual prompt, the image model, image params (aspect ratio, size, seed), and the **content hash of each referenced character sheet, location sheet, and element reference**. Crucially, the hash is over the _referenced sheets' hashes_, not their URLs — a character sheet that's been regenerated with a new URL but identical inputs should not invalidate dependent frames.
- **Frame video** — the source image URL (or variant hash), motion prompt, motion model, duration, fps, aspect ratio.
- **Frame audio** — music prompt, tags, duration, audio model.
- **Character sheet** (`characters.sheetImageUrl`) — character bible entry, talent reference hash (if any), style config, image model.
- **Location sheet** (`locationSheets.referenceImageUrl`, `locationLibrary.referenceImageUrl`) — location bible entry, library location reference hash (if any), style config, image model.
- **Talent sheet** (`talentSheets`) — talent metadata, reference media hashes, image model.

Model _version strings_ count as inputs. If we upgrade an image model, every existing artifact it produced becomes stale — which is the correct behaviour.

### Where the hash lives

One column per artifact per row. The column is nullable because pre-existing rows won't have one until they're regenerated.

| Table             | New columns                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------ |
| `frames`          | `thumbnail_input_hash`, `variant_image_input_hash`, `video_input_hash`, `audio_input_hash` |
| `frame_variants`  | `input_hash` (single artifact per row)                                                     |
| `characters`      | `sheet_input_hash`                                                                         |
| `location_sheets` | `input_hash`                                                                               |
| `locationLibrary` | `reference_input_hash`                                                                     |
| `talent_sheets`   | `input_hash`                                                                               |

We deliberately do **not** add a `content_hash` column on upstream entities themselves (characters, locations, talent) — the referenced-sheet's `input_hash` _is_ the content hash for downstream staleness. This avoids a second-order invalidation layer.

### Where the helpers live

A new `src/lib/ai/input-hash.ts` exports one `computeInputHash` variant per artifact type. Each helper accepts the minimal input DTO it needs (never a whole DB row) and returns a `string`. This keeps callers honest about what counts as input and makes the helpers trivially unit-testable without DB setup.

The existing `src/lib/utils/hash.ts` (`simpleHash`) is not cryptographic and is too weak for this purpose — it stays where it is for its existing non-security uses, and the new staleness helpers use `crypto.subtle.digest('SHA-256', ...)` or `Bun.CryptoHasher`.

Canonical serialization matters: object key order, array order for unordered sets (character refs), and trimming of free-text prompts all need to be deterministic. The helper file is the one place this is defined.

### Staleness as a derived read

```ts
// ScopedDb frame method, illustrative
async isStale(frameId: string, artifact: 'thumbnail' | 'variantImage' | 'video' | 'audio'): Promise<boolean> {
  const frame = await this.get(frameId);
  const stored = frame[`${artifact}InputHash`];
  if (!stored) return false; // never generated — not stale, just absent
  const current = await computeInputHashForArtifact(this, frame, artifact);
  return current !== stored;
}
```

The UI calls this (or a batch variant) when rendering. There is no cascading propagation, no dirty-bit table, no LISTEN/NOTIFY. The staleness calculation is a pure read of the current graph — if character sheets haven't changed, their hash is the same, and the comparison trivially passes.

## Pillar 2: Workflow input snapshots

Workflows must not read mutable state inside a `step.do()` for anything that should be frozen. The "input snapshot" is just the fully-resolved input DTO, passed end-to-end through the Cloudflare Workflows event payload.

### The pattern

**At trigger time** (server handler/function, before `triggerWorkflow()` calls the workflow binding):

1. Resolve every referenced sheet URL and read its `input_hash`.
2. Assemble the full input DTO for the workflow — prompt, model, params, referenced sheet hashes.
3. Compute `snapshotInputHash = computeInputHash(dto)`.
4. Pass the DTO _and_ `snapshotInputHash` to `triggerWorkflow()`, which resolves the Cloudflare Workflows binding and calls `binding.create({ id, params })`.

**At workflow-start**: the workflow validates `snapshotInputHash` matches what it recomputes from the DTO (cheap tamper/format check), then proceeds using only the DTO.

**At write time** (inside the final `step.do()` that commits the artifact): recompute `currentInputHash` from the _live_ scoped-DB state, and branch on whether it still matches `snapshotInputHash`. (See Pillar 3.)

### Per-workflow snapshot modules

There is no centralized `snapshot` config on `OpenStoryWorkflowEntrypoint`. Each migrated workflow owns a companion `*-snapshot.ts` module that:

1. **Builds the inlined DTO at trigger time** (server function / parent workflow) from live scoped-DB state — e.g. `buildRegenerateShotSnapshot` in `regenerate-shots-snapshot.ts`, scene snapshot builders in `sheet-snapshots.ts`.
2. **Hashes the DTO** for tamper detection — e.g. `computeRegenerateShotsBatchHash`, `computeShotImagesHashFromDto`, per-artifact helpers in `image-workflow-snapshot.ts`.
3. **Validates at workflow start** inside `step.do('validate-snapshot')` by recomputing the hash from `event.payload` and comparing to `snapshotInputHash`.
4. **Branches at write time** by recomputing a current hash from live state and comparing to the frozen `snapshotInputHash` — convergent results apply as primary; divergent results route through `sheet-divergence.ts` or `frame_variants` insert helpers.

```ts
// illustrative — RegenerateShotsWorkflow start-time validation
await step.do('validate-snapshot', async () => {
  const expected = event.payload.snapshotInputHash;
  if (!expected) return;
  const recomputed = await computeRegenerateShotsBatchHash(event.payload);
  if (recomputed !== expected) {
    throw new NonRetryableError(
      'snapshotInputHash does not match the inlined DTO'
    );
  }
});
```

Workflows that have not been migrated yet keep their existing behaviour until they gain a `*-snapshot.ts` module and the trigger path inlines the DTO.

### Per-workflow input surface

For the workflows that do content generation, "input" is specifically:

- **`regenerateShotsWorkflow`** (`RegenerateShotsWorkflowInput`, `src/lib/workflows/regenerate-shots-workflow.ts`) — **reference implementation.** Trigger time inlines `shotSnapshots` (per-shot prompt, reference URLs, and sheet hashes via `buildRegenerateShotSnapshot`), freezes `aspectRatio`, and sets `snapshotInputHash` from `computeRegenerateShotsBatchHash`. The workflow body reads only the inlined DTO; start-time validation runs in `step.do('validate-snapshot')`.
- **`shotImagesWorkflow`** (`ShotImagesWorkflowInput`, `src/lib/workflows/shot-images-workflow.ts`) — inlines `sceneSnapshots` (per-scene upstream sheet hashes) and optional `snapshotInputHash`. Hash helpers live in `image-workflow-snapshot.ts` and `sheet-snapshots.ts`.
- **`characterSheetWorkflow`** (`CharacterSheetWorkflowInput`) — inlines character/talent metadata and reference URLs; carries `snapshotInputHash`. Write-time divergence routes through `decideSheetDivergence` / `saveDivergentCharacterSheet` in `sheet-divergence.ts`.
- **`locationSheetWorkflow`** (`LocationSheetWorkflowInput`) — same pattern for location sheets and library-location references.
- **`libraryTalentSheetWorkflow`** (`LibraryTalentSheetWorkflowInput`) — inlines `referenceImageUrls`, `talentDescription`, and `snapshotInputHash`. Talent media is append-only in practice, so the snapshot is the list of reference URLs themselves.

Most migrations are additive — payloads already carry most of the data. The work is inlining hashes, validating at start, and branching at write time.

### Snapshot size

Cloudflare Workflows has event payload size limits, but our payloads are dominated by prompts, sheet URLs, and metadata — not by the artifacts themselves, which are accessed by URL. We inline snapshots into the payload in v1. If that becomes a problem we add a `workflow_input_snapshots` table with content-addressable storage (as the original doc proposed), but this is not part of v1.

## Pillar 3: Divergence-on-completion

Before writing a generation result, compare hashes:

```ts
// illustrative — runs inside a sheet workflow's final step.do()
const snapshotInputHash = input.snapshotInputHash ?? null;
const currentInputHash = await computeCharacterSheetHashCurrent(
  input,
  scopedDb
);
const decision = decideSheetDivergence(snapshotInputHash, currentInputHash);

if (decision.kind === 'convergent') {
  // Inputs unchanged — apply as the primary sheet (existing behaviour)
  await scopedDb.characters.updateSheet(characterId, {
    url,
    inputHash: currentInputHash,
  });
} else {
  // Diverged mid-generation — park in variants without disturbing live state
  const { id: divergedVariantId } = await saveDivergentCharacterSheet({
    scopedDb,
    characterId,
    sequenceId,
    model,
    url,
    snapshotInputHash: decision.snapshotInputHash,
    currentInputHash: decision.currentInputHash,
  });
  await getGenerationChannel(sequenceId).emit('generation.stale:detected', {
    entityType: 'character',
    entityId: characterId,
    artifact: 'sheet',
    snapshotInputHash: decision.snapshotInputHash,
    divergedVariantId,
  });
}
```

Per-shot image artifacts follow the same hash comparison inside `image-workflow` / `regenerate-shots-workflow`, routing divergent thumbnails into `frame_variants` and emitting `generation.stale:detected` with `entityType: 'shot'`.

### Where diverged results land

- **Per-frame image/video/audio**: insert into `frame_variants` (`src/lib/db/schema/frame-variants.ts`) tagged with the model that produced them and the `snapshotInputHash` that scoped them. The user sees an "alternate available" affordance and can promote it or regenerate from current inputs.

  The table carries two partial unique indexes:
  - `frame_variants_primary_key` on `(frameId, variantType, model)` WHERE `diverged_at IS NULL` — at most one primary row per model. `image-workflow`'s speculative pre-write and convergent reconcile both target this slot.
  - `frame_variants_divergent_key` on `(frameId, variantType, model, input_hash)` WHERE `diverged_at IS NOT NULL` — divergent alternates are inserted (not updated) and distinguished by `input_hash`, so multiple divergences of the same model coexist.

  On divergence, the workflow performs three writes (revert frame thumbnail, revert primary variant row's speculative URL, insert divergent alternate). These should land in a transaction once `scopedDb` exposes one — see the "Outstanding hardening" notes on PR #633.

- **Frame variant artifacts** (already-variant rows being regenerated): leave the row as-is but do not promote it to the frame's primary thumbnail/video/audio. The `diverged_at` timestamp marks the divergence for the UI.

- **Sheet entities** (character, location, library location, talent), **sequence-level merged video**, **sequence-level music**, **prompts**: no variants infrastructure today. For stage 1 we **discard and re-queue**: log the divergence, emit a realtime event, trigger a new workflow with the current inputs. Each of these gets a proper variants table in later stages (see below).

### Realtime event

`realtimeSchema.generation` in `src/lib/realtime/index.ts` defines `stale:detected` as a discriminated union on `entityType`. Clients subscribe on the generation channel and listen for the dotted path `generation.stale:detected`:

```ts
'stale:detected': z.discriminatedUnion('entityType', [
  z.object({
    entityType: z.literal('shot'),
    entityId: z.string(),
    artifact: z.enum(['thumbnail', 'variant-image', 'video', 'audio']),
    snapshotInputHash: z.string(),
    divergedVariantId: z.string(),
  }),
  z.object({
    entityType: z.literal('character'),
    entityId: z.string(),
    artifact: z.literal('sheet'),
    snapshotInputHash: z.string(),
    divergedVariantId: z.string(),
  }),
  // ...location, library-location, talent, and sequence (music) branches
]),
```

`divergedVariantId` is required on every branch — emitters in `sheet-divergence.ts` and `regenerate-shots-workflow.ts` always park the divergent artifact first, then reference the new variant row's id. This gives the UI a single event shape across entity types without adding new channels.

## How it composes with existing patterns

- **Scoped DB** (`src/lib/db/scoped/*`) is the only entry point. Staleness reads go through scoped getters; hash computation helpers accept a `ScopedDb` and use it. No code path bypasses team scoping.
- **Per-workflow snapshot modules** (`*-snapshot.ts`) own DTO building, hashing, and validation — existing workflows keep working unchanged until they gain one.
- **Status columns** stay `pending | generating | completed | failed`. Staleness does not become a fifth value. The UI composes `status === 'completed' && isStale(entity)` when it needs "completed but stale".
- **`frame_variants`** is the divergence sink for frame artifacts in addition to its existing role for per-model alternates. The unique key was split into two partial indexes (primary slot vs divergent alternates keyed by `input_hash`) so primaries and alternates of the same model coexist without overwriting each other. `input_hash` and `diverged_at` are columns on this table.

## Future stages

Stage 1 (this doc's main body) ships input-hash staleness, workflow snapshots, and divergence routing for per-frame artifacts that already have a home in `frame_variants`. Everything below is deliberately deferred — listed both so it doesn't creep in by accident, and so the order is clear when we do pick it up.

### Stage 2: sheet variants

Adds variants tables for character sheets, location sheets, and talent sheets so divergence-on-completion can save a competing sheet without overwriting the live one.

- **New tables** — `character_sheet_variants`, `location_sheet_variants` (covering both `locationSheets` and `locationLibrary`), `talent_sheet_variants`. Each carries the same shape as `frame_variants`: parent FK, model, URL/path, `input_hash`, `diverged_at`, status, error.
- **Replaces stage-1 re-queue behaviour** for these entities — divergence inserts a row instead of triggering a new workflow.
- **UI surface** — "alternate available" affordance on character/location/talent detail views, parallel to what frames already get.
- **Trigger** — pick this up when we see real-world divergence on sheet workflows (recasts during generation are the obvious case) or when users start asking to compare sheet outputs across models.

### Stage 3: sequence-level video and music variants

Sequence-level merged video (`sequences.mergedVideoUrl`, `mergedVideoPath`, …) and sequence-level music (`sequences.musicUrl`, `musicPath`, `musicPrompt`, `musicTags`, …) are stored as columns directly on `sequences`. They have no variants story, so:

- **`sequence_video_variants`** — captures alternate merged videos. Columns: `sequenceId`, `url`, `path`, `model`/`workflow`, `input_hash`, `status`, `diverged_at`, `created_at`. The input-hash for merged video is over the ordered list of source frame video hashes plus `targetFps`/`resolution` from `MergeVideoWorkflowInput`.
- **`sequence_music_variants`** — captures alternate music tracks. Columns: `sequenceId`, `url`, `path`, `prompt`, `tags`, `model`, `duration`, `input_hash`, `status`, `diverged_at`, `created_at`. The input-hash is over `prompt + tags + duration + model`. The merged final video then becomes a function of `(merged_video_variant, music_variant)`, and `merge-audio-video-workflow.ts` takes both as explicit inputs.
- **Promotion** — promoting a variant updates the matching `sequences.*Url`/`*Path` columns. The columns stay (existing UI reads from them) — the variants table is purely additive.
- **Trigger** — needed once users start trying alternate music tracks or want to compare cuts before committing.

### Stage 4: prompt versioning

Prompts currently exist in three forms with no history:

- AI-generated visual/motion prompts inside `frame.metadata.prompts.{visual,motion}.fullPrompt` (and components/parameters).
- User overrides in `frames.imagePrompt` and `frames.motionPrompt` (overwrite the AI version on save — the previous text is lost).
- Sequence-level `sequences.musicPrompt` / `musicTags` (also overwrite-on-save).

Prompts are themselves generated artifacts of an upstream context (scene metadata, character/location bibles, style config, analysis model). They deserve the same input-hash + variants treatment as visual artifacts, both for staleness ("your scene metadata changed; the visual prompt is stale") and for history ("revert to the AI-generated prompt before I edited it").

- **`frame_prompt_variants`** — one row per prompt revision. Columns: `frameId`, `promptType` (`'visual' | 'motion'`), `text`, `components` (json), `parameters` (json), `source` (`'ai-generated' | 'user-edit' | 'regenerated'`), `input_hash` (over the upstream context that produced an AI prompt; null for user edits), `analysisModel`, `created_at`, `created_by`. The "current" prompt is the most recent row of each type.
- **`sequence_music_prompt_variants`** — same shape, parent on `sequenceId`, `promptType` `'music'`, fields capture both `prompt` and `tags`.
- **Read path** — `frame.imagePrompt`/`motionPrompt` and `sequences.musicPrompt`/`musicTags` stay as cached "current" pointers (no read change for callers); writes go through a helper that inserts a variant row and updates the cached column atomically.
- **Migration of existing prompts** — backfill is unnecessary; existing prompts are simply the row before the first new variant. The variant chain starts from the next save.
- **Staleness for prompts** — visual and motion prompts get `*_prompt_input_hash` columns on `frames`, computed from scene metadata + style config + character/location bible + analysis model. When upstream context changes, the prompt itself is flagged stale (independently of whether the rendered image is stale). Music prompts similarly hash over `sequence.musicDesign` plus the analysis model.
- **Trigger** — pick this up alongside or before stage 2/3 if user prompt-editing UX surfaces a need for undo/history; otherwise it can come after.

### Stage 5: dependency materialization

Everything else from the original doc that we're explicitly _not_ implementing yet:

- **`frame_dependencies` edge table.** Keep inferring from `characterTags` / `matchCharactersToScene` (`src/lib/workflows/scene-matching.ts`, used by `sheet-snapshots.ts` and `shot-images-workflow.ts`) until there's a concrete reason to materialize it — e.g., needing to walk dependents faster than a scan allows.
- **`stale` as a status enum value.** The derived boolean is sufficient until it isn't.
- **Topological regeneration queue.** Not needed until we have a materialized dependency graph to walk.
- **Content-addressable snapshot table** (`workflow_input_snapshots`). Not needed until inlining snapshots into Cloudflare Workflows payloads actually strains the payload-size budget.

## Decision summary

Answering every row of the original doc's decision table for our stack:

| Original decision area   | Original recommendation                   | This doc                                                                                                                                                                          |
| ------------------------ | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Versioning approach      | Immutable snapshots + version chains      | **Adapted**: per-artifact `input_hash` (stage 1). Variants tables for sheets, sequence video/music, and prompts (stages 2-4). No version chains.                                  |
| Staleness detection      | Content hash comparison                   | **Kept**: SHA-256 input-hash comparison, derived at read time.                                                                                                                    |
| Invalidation propagation | Lazy dirty bits + demand verification     | **Adapted**: no dirty-bit table; staleness is a pure read of the current graph.                                                                                                   |
| Collaborative sync       | Property-level LWW + transactions         | **Dropped**: not a concurrent editor. Server is authoritative.                                                                                                                    |
| Workflow isolation       | Application-level snapshots               | **Kept**: snapshot inlined in the Cloudflare Workflows payload; per-workflow `*-snapshot.ts` modules build, hash, and validate it.                                                |
| Lifecycle management     | XState machines                           | **Dropped**: existing status columns are sufficient.                                                                                                                              |
| Workflow orchestration   | Inngest (or Temporal)                     | **Dropped**: Cloudflare Workflows already does this.                                                                                                                              |
| Real-time events         | Redis pub/sub + PG NOTIFY                 | **Kept, different plumbing**: typed SSE events delivered through `RealtimeChannel` Durable Objects; one new event type.                                                           |
| Job distribution         | SKIP LOCKED queue                         | **Dropped**: Cloudflare Workflows is the durable job engine.                                                                                                                      |
| Branching                | `parentVersion` + branch names            | **Dropped**. Variants tables (stages 2-4) cover the realistic "keep old vs new" use case.                                                                                         |
| Divergence handling      | Three options: re-queue / alternate / ask | **Adapted**: per-frame artifacts save to `frame_variants` (stage 1); sheets, sequence-level video/music, and prompts get their own variants tables in stages 2-4. No user prompt. |

## Where to start (stage 1)

Recommended build order for stage 1, each step independently shippable:

1. `src/lib/ai/input-hash.ts` with the per-artifact helpers and their unit tests. No schema changes yet.
2. Add `input_hash` and `diverged_at` columns to `frame_variants`, plus `input_hash` to the sheet tables. Backfill is unnecessary — null means "unknown, treat as non-stale". Split the existing `(frameId, variantType, model)` unique index into `frame_variants_primary_key` (WHERE `diverged_at IS NULL`) and `frame_variants_divergent_key` on `(frameId, variantType, model, input_hash)` (WHERE `diverged_at IS NOT NULL`) so divergent alternates can coexist with the primary slot.
3. Add the four `*_input_hash` columns to `frames`.
4. Add or extend per-workflow `*-snapshot.ts` helpers for each content-generation workflow (DTO build at trigger time, hash at trigger time, `computeCurrent` for write-time checks).
5. **`RegenerateShotsWorkflow` is the reference implementation** — already migrated end-to-end with `regenerate-shots-snapshot.ts`, start-time validation, and divergence routing into `frame_variants`. Use it as the template for remaining workflows.
6. `realtimeSchema.generation['stale:detected']` is live; wire additional UI surfaces to `generation.stale:detected` as needed.
7. Migrate remaining workflows one at a time (`shotImagesWorkflow`, sheet workflows, etc.).

Each step preserves the existing system; nothing in here requires a big-bang migration. Stages 2-5 are taken on independently, in whatever order user-facing pressure dictates.
