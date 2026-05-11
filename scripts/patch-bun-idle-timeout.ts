#!/usr/bin/env bun
export {}; // Make this a module so top-level await typechecks.
/**
 * Post-build: inject Bun.serve `idleTimeout` into the Nitro bun-preset output.
 *
 * Nitro's bun preset (node_modules/nitro/dist/presets/bun/runtime/bun.mjs:34)
 * passes `bun: { websocket: ... }` straight to srvx → Bun.serve. Bun.serve's
 * default idleTimeout is 10s, which kills slow streaming responses (e.g.
 * record-mode aimock buffering an OpenRouter SSE response before relaying).
 * There's no Nitro config knob for this, and the vite-side workaround in
 * `bunDevIdleTimeout` only applies to `vite dev`. So we patch the built
 * output: replace the `bun: { websocket: void 0 }` literal in
 * .output/server/index.mjs with `bun: { websocket: void 0, idleTimeout: 255 }`
 * (255s is Bun's max).
 */

const TARGET = '.output/server/index.mjs';
const FROM = /bun:\s*\{\s*websocket:\s*void 0\s*\}/;
const TO = 'bun: { websocket: void 0, idleTimeout: 255 }';

const file = Bun.file(TARGET);
if (!(await file.exists())) {
  console.error(
    `[patch-bun-idle-timeout] ${TARGET} not found — run \`vite build\` first.`
  );
  process.exit(1);
}

const src = await file.text();
if (src.includes('idleTimeout: 255')) {
  console.log(`[patch-bun-idle-timeout] already patched, skipping.`);
  process.exit(0);
}

if (!FROM.test(src)) {
  console.error(
    `[patch-bun-idle-timeout] couldn't find Bun.serve options pattern in ${TARGET}. ` +
      `Nitro may have changed its emitted code — inspect \`${TARGET}\` around the \`serve({...})\` call.`
  );
  process.exit(1);
}

await Bun.write(TARGET, src.replace(FROM, TO));
console.log(`[patch-bun-idle-timeout] patched ${TARGET}: idleTimeout=255s`);
