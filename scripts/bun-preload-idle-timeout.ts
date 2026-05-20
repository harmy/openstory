/**
 * Lift Bun.serve's 10s default idleTimeout for the vite dev server, which
 * kills long-running streaming server-fn responses (structured-output LLM
 * streams) mid-flight with "request timed out after 10 seconds" and a client
 * "TypeError: network error".
 *
 * Use Bun's maximum allowed value (255 seconds) — `idleTimeout: 0` does NOT
 * disable the timeout, it falls back to the default 10s. This matches the
 * post-build Nitro patch in `scripts/patch-bun-idle-timeout.ts`.
 *
 * Bun's node:http shim caches its Bun.serve reference before vite plugins
 * run, so patching from inside vite.config.ts is too late. Bun's --preload
 * runs this file before any other module loads, which catches every Bun.serve
 * call from anywhere in the process.
 *
 * Wired up via package.json: `bun --bun --preload ./scripts/bun-preload-idle-timeout.ts vite dev`.
 */
export {};

type ServeFn = (opts: Record<string, unknown>) => unknown;
type PatchableBun = {
  serve: ServeFn & { __idleTimeoutPatched?: true };
  version?: string;
};

declare const Bun: PatchableBun | undefined;

// Bun's max — `0` would mean "use the default 10s", not "disabled".
const MAX_IDLE_TIMEOUT_SECONDS = 255;

if (typeof Bun !== 'undefined' && typeof Bun.serve === 'function') {
  if (!Bun.serve.__idleTimeoutPatched) {
    const original = Bun.serve;
    const patched: ServeFn & { __idleTimeoutPatched?: true } = (opts) => {
      const port = (opts as { port?: number }).port ?? '?';
      console.log(
        `[bun-preload-idle-timeout] intercepting Bun.serve port=${port} idleTimeout=${MAX_IDLE_TIMEOUT_SECONDS}`
      );
      return original({ ...opts, idleTimeout: MAX_IDLE_TIMEOUT_SECONDS });
    };
    patched.__idleTimeoutPatched = true;
    Bun.serve = patched;
    console.log(
      `[bun-preload-idle-timeout] installed (Bun ${Bun.version ?? '?'})`
    );
  }
}
