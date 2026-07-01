# Staleness and divergence UX

Companion to [workflow-snapshots-and-content-hash-staleness.md](./workflow-snapshots-and-content-hash-staleness.md). The architecture doc is intentionally backend-heavy — it specifies hashes, snapshots, and divergence routing but punts on what the user sees. This is the answer.

The architecture surfaces two new states through a single realtime event (`generation.stale:detected`) and a derived `isStale(entity, artifact)` reader. Both states need UI, but they're meaningfully different — and conflating them is the most likely way the UX fails.

## Vocabulary

We use two names, deliberately. Treat them as load-bearing — copy in the UI sticks to these terms.

| Term                    | When it applies                                                                                                                                        | What it means to the user                                                                                                                                                                       |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Stale**               | `computeInputHash(entity) !== entity.<artifact>_input_hash`, derived at read time.                                                                     | "What you're looking at was generated from inputs that have since changed. The image / video / sheet itself is fine, but it's no longer the answer to the question you're asking."              |
| **Divergent alternate** | A `frame_variants` row (or stage 2 sheet variant) with `diverged_at IS NOT NULL`, produced when a workflow finished but its inputs changed mid-flight. | "You started a regeneration. While it was running, you (or your collaborator) edited an upstream input. Rather than overwrite the new inputs with old work, we set this aside as an alternate." |

A single artifact can be **stale**, **have a divergent alternate**, both, or neither. The UI handles them as distinct, composable states.

A frame can also have **per-model alternates** — that's the existing `frame_variants` rows generated when the user explicitly tries a different model. Those are _not_ divergent alternates and don't surface either of the new affordances. The `diverged_at` column is what distinguishes the two.

## Two new shared primitives

Both are slim, non-modal, sit inline with the artifact they describe, and reuse the project's `<Alert>` shape. Neither blocks interaction.

### `<StalenessIndicator>`

```
[ ⚠  Inputs changed since this was generated.    [ Regenerate ]  [ ✕ ] ]
```

Props:

- `artifact: 'thumbnail' | 'video' | 'audio' | 'sheet' | 'visual-prompt' | 'motion-prompt' | 'music-prompt'`
- `entityType: 'frame' | 'character' | 'location' | 'library-location' | 'talent' | 'sequence'`
- `onRegenerate: () => void`
- `onDismiss?: () => void` — soft-dismiss for this session only; doesn't change DB state.
- `density?: 'inline' | 'corner-dot'` — `inline` for detail views, `corner-dot` for cards / lists.

Single primary action: **Regenerate** with current inputs. Dismiss is for the user who's intentionally keeping a stale render around to compare against the new one — it's session-scoped, no persistence.

The corner-dot variant collapses to an 8px amber dot positioned where `Check`/`Loader2` already render on `scene-list-item.tsx:58-81`. Clicking the dot jumps focus to the matching detail view's full banner.

### `<DivergentAlternateBanner>`

```
[ ⓘ  An alternate was generated with the inputs you had at the time.  [ Compare ]  [ Promote ]  [ Discard ] ]
```

Props:

- `variantId: string`
- `entityType` / `artifact` (same union as above)
- `onCompare: () => void`
- `onPromote: () => void`
- `onDiscard: () => void`
- `density` (same)

Three actions, in this order: **Compare** (opens the comparison dialog — preview before commitment), **Promote** (replace the live primary with this alternate), **Discard** (soft-delete via `discarded_at` column on the variant row; doesn't physically delete the artifact so we can recover from misclicks).

When both states apply at once (the live primary is stale **and** there's a divergent alternate), the divergent banner takes precedence — the alternate is, by definition, generated from the inputs that are now live in the DB. Promoting it resolves both states. The staleness indicator is suppressed in this case to avoid double-banner clutter.

## Divergence resolution flow

The default flow:

1. Workflow finishes, recomputes `currentInputHash`, finds it diverges from `snapshotInputHash`. Writes to `frame_variants` with `diverged_at = now()`. Emits `stale:detected` with the new `divergedVariantId`.
2. Sonner toast on the affected sequence's view: _"An alternate version is available for Scene 4."_ Click → focuses the frame detail.
3. `<DivergentAlternateBanner>` appears in-place (frame detail right rail; corner dot on the scene card).
4. User picks one of three branches:

### Compare

Opens `<DivergenceCompareDialog>`. Two-column layout:

```
┌─────────────────── Compare alternate ──────────────────┐
│                                                          │
│   Live (current inputs)         Alternate (older inputs) │
│   ┌──────────────────┐          ┌──────────────────┐     │
│   │                  │          │                  │     │
│   │   <thumbnail>    │          │   <thumbnail>    │     │
│   │                  │          │                  │     │
│   └──────────────────┘          └──────────────────┘     │
│                                                          │
│   What changed:                                          │
│   • Character "Alex" — sheet regenerated                 │
│   • Location "Warehouse" — recast                        │
│                                                          │
│                         [ Discard ]  [ Promote ] [ Cancel ] │
└──────────────────────────────────────────────────────────┘
```

The "What changed" panel is computed by diffing the snapshot DTO carried in the variant's `input_hash` provenance against the current entity state. For stage 1 we surface only the upstream-entity-level diff (which characters / locations / sheets changed) — not field-level prompt diffs. Field-level lands in stage 4 alongside prompt history.

For non-image artifacts (video, audio): same dialog shape, with `<video>` or `<audio>` controls instead of `<img>`.

### Promote

Reuses the recast-confirm pattern (`src/components/talent/recast-confirm-dialog.tsx`):

```
Promote alternate?

This will replace the current image with the alternate
version. The motion video, if any, will be marked stale.

[ Cancel ]  [ Promote ]
```

The "motion video, if any, will be marked stale" copy adapts based on which downstream artifacts exist for the entity. The mutation:

1. Copies the variant's `url` / `path` into the primary slot on `frames` (`thumbnailUrl`, `thumbnailPath`, etc.).
2. Sets the matching `*_input_hash` column on `frames` to the variant's `input_hash`.
3. Deletes the variant row (or sets `discarded_at` — see below).
4. Emits `image:progress` / `video:progress` / `audio:progress` with `status: completed` so existing realtime listeners refresh.

### Discard

Soft-delete: set `discarded_at = now()` on the variant row. UI hides discarded variants. We keep the artifact addressable for recovery and audit. No confirmation dialog; instead show a sonner toast with an Undo action that clears `discarded_at`.

## Staleness surfacing matrix

One row per `(entityType, artifact)` from the `stale:detected` payload. "Stage" is the architecture-doc stage that lands the backend support.

| Entity / artifact            | Surface (card)                                                 | Surface (detail)                                                        | Stage |
| ---------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------- | ----- |
| `frame` / `thumbnail`        | corner dot on `scene-list-item`                                | inline banner on `scenes-view` image-prompt tab                         | 1     |
| `frame` / `video`            | (none — same card; covered by thumbnail dot if both)           | inline banner on motion-prompt tab                                      | 1     |
| `frame` / `audio`            | (none)                                                         | inline banner on (future) audio tab                                     | 1     |
| `frame` / `variant-image`    | (none — internal; only matters for the divergence path itself) | banner inside the per-model variants area in `scene-script-prompts.tsx` | 1     |
| `character` / `sheet`        | corner dot on `talent-card`                                    | inline banner above sheet image in `character-detail-view`              | 2     |
| `location` / `sheet`         | corner dot on `location-card`                                  | inline banner above reference image in `location-detail-view`           | 2     |
| `library-location` / `sheet` | corner dot on `location-library-card`                          | inline banner in `location-library` edit dialog                         | 2     |
| `talent` / `sheet`           | corner dot on `talent-library-card`                            | inline banner in `talent-library` edit dialog                           | 2     |
| `sequence` / merged video    | (none)                                                         | inline banner above scene player when merged-video is stale             | 3     |
| `sequence` / music           | (none)                                                         | inline banner in `music-view`                                           | 3     |
| `frame` / `visual-prompt`    | (none)                                                         | "prompt stale" badge on image-prompt tab + history sheet                | 4     |
| `frame` / `motion-prompt`    | (none)                                                         | "prompt stale" badge on motion-prompt tab + history sheet               | 4     |
| `sequence` / `music-prompt`  | (none)                                                         | "prompt stale" badge in `music-view` + history sheet                    | 4     |

Stage 1 is the only row block we commit to in v1. The rest is sketched so that when the matching stage backend ticket is picked up, the UI work has a clear home and consistent vocabulary.

## Bulk operations

Single proposal, deferred to stage 1.5 or stage 2:

- A "Stale" filter pill at the top of the scene list (`scene-list.tsx`) that hides non-stale frames.
- When the filter is active, a "Regenerate all stale" CTA appears next to the filter, triggering one `regenerateShotsWorkflow` for the union of stale shots.

Not in v1. Listed here so it has a documented home when we pick it up.

## Backend prerequisites the UI assumes

Backend implementation details that need to be in place before the divergence UI works correctly:

1. **`frame_variants` unique indexes** (resolved in #615). The schema now carries two partial unique indexes instead of a single `(frameId, variantType, model)` constraint:
   - `frame_variants_primary_key` on `(frameId, variantType, model)` WHERE `diverged_at IS NULL` — at most one primary slot per model. `image-workflow`'s speculative upsert and convergent reconcile both target this index.
   - `frame_variants_divergent_key` on `(frameId, variantType, model, input_hash)` WHERE `diverged_at IS NOT NULL` — divergent alternates distinguished by input-hash, so multiple divergences of the same model can coexist.

   Implication for the UI: the corner-dot count and the comparison dialog both query `diverged_at IS NOT NULL` rows. A frame can have multiple divergent alternates of the same model (one per distinct `input_hash`), and the dialog should list them in `diverged_at` order.

2. **`promptHash` vs `input_hash`.** `frame_variants.promptHash` already exists (`frame-variants.ts`). Either reuse it as the new `input_hash` (rename) or add `input_hash` as a separate column — #614's call. The UI reads through the scoped getter, so as long as one of them is the canonical staleness signal, the UI is unaffected.

   _Status_: Stage 1 added `input_hash` as a separate column alongside `promptHash`. `input_hash` is the canonical staleness signal; `promptHash` is unchanged.

## Out of scope for v1

- Prompt history UI (stage 4 — sketched in matrix, no v1 commitment).
- Sequence-level merged-video / music variant UI (stage 3 — same).
- Library-location variants UI (stage 2 backend doesn't yet differentiate library from per-sequence; the matching UI ticket can decide).
- A sequence-wide "stale audit" page.
- Bulk-regenerate UI (proposed, deferred to stage 1.5 / stage 2).
- Field-level diffing inside `<DivergenceCompareDialog>` (lands with stage 4 prompt history).

## Open questions

- **Toast frequency.** If a long workflow lands many divergent variants in quick succession (a recast that diverges across N frames), do we toast once with a count, or once per frame? Default: debounce to one toast per sequence per 5s with a count.
- **Promote-while-generating.** What happens if the user clicks Promote on a variant while a fresh regenerate is already in flight? Default: confirm dialog warns and offers to cancel the in-flight workflow, then promotes. Implementation depends on tracking the relevant Cloudflare Workflows instance ids and terminating the in-flight run safely before promotion.
