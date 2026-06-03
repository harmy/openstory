---
title: Style Sample Videos
description: Generate, score, render, upload, and seed the canonical + bespoke sample videos shown on each style
section: Developer Guide
order: 6
---

Every style carries a short **sample video** that demos the look. There are two
flavours:

- **Canonical** (every style) — a per-category one-line brief is run through the
  app's own script-enhancer and split into 2–3 render-ready beats, so each style
  gets a style-appropriate ~15s script.
- **Bespoke** (~10 hero styles) — a hand-curated script from `BESPOKE_SCRIPTS`.

Each beat is rendered the same way: **generate a starting still → image-to-video
from that still → concatenate the clips into one mp4**. The starting still is
quality-gated and re-rolled on a clear failure _before_ the expensive
image-to-video step, because a sample video has no later pick-the-best safety
net — a bad frame would be animated as-is.

All the moving parts live in `scripts/generate-style-sample-videos.ts`,
`scripts/upload-style-sample-videos-to-r2.ts`,
`scripts/seed-style-sample-videos.ts`, and the data/helpers in
`src/lib/style/sample-videos.ts`.

## Prerequisites

- `OPENROUTER_KEY` — script-enhancer (canonical scripts) **and** the still-quality gate.
- `FAL_KEY` — still + video generation. Without it the render command is a dry-run.
- `ffmpeg` on `PATH` — clips are concatenated with the system binary.
- Cloudflare creds for upload — the default path shells out to `wrangler`.

## How a render actually runs

It is **one command**, not separate passes. Inside that command, per style, the
order is:

```
for each beat (in parallel):
    renderStill():
        for attempt 1..STILL_ATTEMPTS (default 3):
            generate still          # text-to-image, recommendedImageModel, 2K
            scoreStill()            # vision LLM, GATE_MODEL
            if passes -> keep it, stop
            else      -> re-roll this beat
        # if none pass: keep the best-scoring still + warn
── barrier: ALL stills finalized ──
for each beat (in parallel):
    renderClip()                    # image-to-video from the still, recommendedVideoModel
concat clips -> {canonical|bespoke}.mp4
```

The four conceptual steps you'd expect — generate image, score, regenerate
failures, generate video — all happen. The first three are **fused into the
inline still gate** (`renderStill`, runs per beat); the barrier at
`renderJob` guarantees every still is final before any video is generated, so a
known-bad frame is never animated. There is intentionally **no** separate
human-review checkpoint between stills and video (unlike `--scripts-only` for
scripts).

**Gate flags** (from `scoreStill`): hard failures that force a re-roll are
**literal-medium** (rendered the medium/artifact — a book, a storyboard sheet —
instead of the scene) and **multi-frame** (a grid/panel/collage instead of a
single shot). **Anatomy** is a soft signal (penalty only, spot-check by hand).
Disable the whole gate with `--no-gate`.

## Steps

### 1. Generate + review the canonical scripts (LLM only, no spend)

```bash
OPENROUTER_KEY=… bun scripts/generate-style-sample-videos.ts --scripts-only
```

Writes `sample-videos/{slug}/canonical.script.json` (enhanced script + beats).
Eyeball a few; the render step reuses these. `--force` regenerates them.

### 2. Score the scripts (gate before you spend on render)

```bash
OPENROUTER_KEY=… bun run styles:sample-videos:score
```

Scores every `canonical.script.json` on style-adherence, brief coverage,
**image-to-video feasibility** (can each `motionPrompt` be produced by one ~5s
i2v from a single still, or does it demand a reveal/crane that warps?), and
lighting fit. Writes `sample-videos/_script-scores.json`, prints a worst-first
report, and exits non-zero when any script has an **infeasible-motion** beat
(hard) or scores below `--threshold` (default 6). Soft advisories flag
golden-hour-against-style and style-bleed (grade/stock named in a beat).

Re-roll a flagged style and re-score:

```bash
bun scripts/generate-style-sample-videos.ts --scripts-only --force --filter "Rom Com"
bun run styles:sample-videos:score --filter "Rom Com"
```

Like the still gate, this exists because a sample video has no later
pick-the-best safety net — a weak script renders faithfully into a weak video.

### 3. Dry-run the render to see the fal.ai bill

```bash
bun scripts/generate-style-sample-videos.ts --dry-run
```

Prints resolved models + the brief + estimated fal.ai spend. (A run with no
`FAL_KEY` is implicitly a dry-run too.)

### 4. Render one style first to sanity-check quality

```bash
FAL_KEY=… OPENROUTER_KEY=… bun scripts/generate-style-sample-videos.ts --filter "Product Ad"
```

Keep `OPENROUTER_KEY` set so the still gate is active. Watch the output mp4 and
the intermediate `_frames/`.

### 5. Render the rest

```bash
FAL_KEY=… OPENROUTER_KEY=… bun run styles:sample-videos
```

Useful flags / env:

| Flag / env                                            | Effect                                      |
| ----------------------------------------------------- | ------------------------------------------- |
| `--filter "<name>"`                                   | One style at a time                         |
| `--canonical-only` / `--bespoke-only` / `--hero-only` | Restrict which samples render               |
| `--force`                                             | Re-render even if the output mp4 exists     |
| `--no-gate`                                           | Skip the still-quality gate                 |
| `MAX_CONCURRENT` (default 3)                          | Parallel videos — heavy on GPU/API quota    |
| `STILL_ATTEMPTS` (default 3)                          | Re-rolls per still before keeping best-of-N |

### 6. Review locally, then upload to R2

```bash
bun scripts/upload-style-sample-videos-to-r2.ts --dry-run   # list keys, no upload
bun run styles:sample-videos:upload                          # wrangler (default)
```

Uploads `canonical.mp4` / `bespoke.mp4` to `styles/{slug}/…` in the public
bucket. The default is `wrangler` (account-wide token, reliable write access).
Only add `--s3` if you have **unscoped** `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` /
`R2_SECRET_ACCESS_KEY` — scoped R2 keys 403 against `openstory-public-assets`.

### 7. Seed the database

```bash
bun run styles:sample-videos:seed:local                      # local D1
bun run styles:sample-videos:seed:d1                         # prod D1 (HTTP)
```

Builds each style's expected R2 URLs, **validates every one is reachable**, and
aborts if any is missing (no partial writes) before writing the
`styles.sampleVideos` JSON for the system team. Add `--dry-run` to validate
without writing.

## Outputs

```
sample-videos/{slug}/
  canonical.mp4                 # final rendered video (every style)
  bespoke.mp4                   # hero styles only
  canonical.script.json         # enhanced script + beats (reviewable, reused)
  _frames/{canonical|bespoke}/
    {beat-id}.webp              # starting stills (intermediate; not uploaded)
    {beat-id}.mp4               # per-beat clips (intermediate)
```

Public URLs after upload:
`https://{VITE_R2_PUBLIC_ASSETS_DOMAIN}/styles/{slug}/{canonical|bespoke}.mp4`.

The `_frames/*.webp` stills are review-only intermediates — nothing downstream
consumes them. The still thumbnails shown in the UI come from the separate
[Style Previews](./style-previews.md) pipeline, not from these video frames.

## TL;DR

```
--scripts-only  →  score  →  --dry-run  →  render --filter (one)  →  render all  →  upload  →  seed
```

Iterate on steps 1–4 for a single style until it looks right, then fan out to
the full set.

## package.json aliases

```bash
bun run styles:sample-videos              # generate scripts/render (steps 1, 5)
bun run styles:sample-videos:score        # score the scripts (step 2)
bun run styles:sample-videos:upload       # upload  (step 6)
bun run styles:sample-videos:seed:local   # seed local D1 (step 7)
bun run styles:sample-videos:seed:d1      # seed prod D1
```
