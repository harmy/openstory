/**
 * Dispose a Cloudflare Workers RPC result.
 *
 * `Workflow.create()` / `Workflow.get()` return `WorkflowInstance` stubs over
 * the Workers RPC layer, and the runtime attaches a disposer (`Symbol.dispose`)
 * to every non-primitive RPC return. If it's never released the remote side
 * keeps the reference open and the runtime logs "An RPC result was not disposed
 * properly" (the warning burst tracked in #933, fired during workflow child
 * fan-out). The GC won't release it in time, so we dispose explicitly once the
 * result is finished with.
 *
 * The parameter is typed `object` (not `Disposable`) because the generated
 * Workers types declare `WorkflowInstance` as a plain class, and the runtime
 * `Symbol.dispose in stub` guard makes this a safe no-op under vitest mocks
 * and any environment where the disposer isn't attached.
 *
 * Disposal is best-effort: it runs inside `finally` blocks at every call site,
 * so a throw from `Symbol.dispose()` would override the caller's real return
 * value or error (e.g. drop a recovered child output, or mislog a completed
 * workflow as a check failure). The leak warning this prevents is non-fatal, so
 * we swallow any disposer throw to guarantee cleanup never alters control flow.
 */
export function disposeRpcStub(stub: object | null | undefined): void {
  if (stub == null || !(Symbol.dispose in stub)) return;
  try {
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- guarded by the `in` check; WorkflowInstance carries the disposer at runtime but isn't typed Disposable
    (stub as Disposable)[Symbol.dispose]();
  } catch {
    // Intentionally ignored — see the best-effort note above.
  }
}
