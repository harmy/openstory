# video-export container

Server-side sequence MP4 export for the **API** (issue #968). A stateless Node
service that stitches a sequence's scene videos and mixes music + dialogue into
one MP4, using [`mediabunny`](https://mediabunny.dev) +
[`@mediabunny/server`](https://www.npmjs.com/package/@mediabunny/server)
(NodeAV / FFmpeg). It runs as a **Cloudflare Container** fronted by the
`VideoExportContainer` Durable Object (`src/lib/containers/video-export-container.ts`).

## Why a container (and not the Worker)

The browser export (`src/lib/sequence-player/export.ts`) relies on WebCodecs +
Web Audio, which Cloudflare Workers don't provide. `@mediabunny/server`
polyfills the full pipeline via NodeAV (native FFmpeg bindings) — that needs a
real Node runtime, hence a container. See CLAUDE.md → "Server-side export".

## Contract

`POST /export` — body `ExportJob` (see `src/types.ts`):

```jsonc
{
  "scenes": [{ "orderIndex": 0, "videoUrl": "https://…/scene0.mp4" }],
  "musicUrl": "https://…/music.mp3", // or null
  "musicLoudnessGainDb": null, // null → measure EBU R128 in-process
}
```

Responds with the MP4 bytes (`content-type: video/mp4`) and an `x-export-meta`
header (URI-encoded JSON `{ durationSeconds, reEncoded, resolutionsLabel }`).
`GET /ping` → `200 ok` (the Container liveness endpoint).

**The container never touches the database.** The Worker-side
`SequenceExportWorkflow` does all DB access, resolves absolute media URLs, calls
this service, and streams the result into R2.

### v1 scope

Concatenates **transmux-compatible** scenes (every scene AVC with a
byte-identical decoder config — the common single-model sequence) and mixes
audio. Mixed-codec / mixed-resolution sequences are rejected with a clear error
(the browser export still handles those client-side); server-side
decode→resize→re-encode is a follow-up.

## Deploy

`wrangler deploy` / Workers Builds builds this Dockerfile and pushes the image
automatically — declared in `wrangler.jsonc` `[env.production]`
(`containers[]` + the `VIDEO_EXPORT_CONTAINER` DO binding + migration `v2`).
Production only, so `bun dev` and e2e need no Docker.

## Local dev (no Docker)

Fastest loop — run the service on the host with bun (`node-av`/FFmpeg works
under the bun runtime), from the repo root:

```bash
bun dev:bunny            # cd containers/video-export && bun install && bun --watch src/server.ts
```

Then exercise it (two copies of one clip = a guaranteed-uniform sequence, so
the transmux path runs):

```bash
curl -sX POST http://localhost:8080/export -H 'content-type: application/json' \
  -o out.mp4 -D - \
  -d '{"scenes":[{"orderIndex":0,"videoUrl":"https://media.w3.org/2010/05/sintel/trailer.mp4"},{"orderIndex":1,"videoUrl":"https://media.w3.org/2010/05/sintel/trailer.mp4"}],"musicUrl":null,"musicLoudnessGainDb":null}'
```

Run it alongside `bun dev` (separate terminal), or use `bun dev:all` which
starts it with the app + Stripe listener. By default the running app can't call
this service (the container binding is production-only) — to wire the full
local loop, set `VIDEO_EXPORT_DEV_URL=http://localhost:8080` in `.env.local` and
the export workflow will POST here instead of the container binding.

## Build / smoke test the image (Docker)

Mirrors what `wrangler deploy` builds. Requires a Docker engine
(OrbStack/Docker Desktop):

```bash
docker build -t openstory-video-export:dev ./containers/video-export
docker run --rm -p 8787:8080 openstory-video-export:dev   # then curl :8787/export as above
```

## Notes

- **Package manager: bun** (`bun.lock`); **runtime: Node** in the image
  (`node dist/server.js`) per the repo convention, bun runtime for `dev:bunny`.
- `node-av`'s postinstall (FFmpeg download) needs `trustedDependencies: ["node-av"]`
  in `package.json` — bun blocks lifecycle scripts otherwise.
- `bun run typecheck` / `bun run build` typecheck the service (also run in the
  Docker build). It is intentionally excluded from the repo's root
  `tsconfig`/oxlint (separate target, own deps).
