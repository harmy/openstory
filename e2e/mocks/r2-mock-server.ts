/**
 * R2 fixture sidecar — lookup/record endpoints for the worker.
 *
 * Under Workerd (cf-plugin), `storage-cloudflare.ts` can't read or write the
 * fixture files directly (no `node:fs`). This sidecar runs on Node, exposes
 * `r2-recorder.ts` over HTTP at port 4011, and is started/stopped alongside
 * the aimock server in `e2e/global-setup.ts` / `global-teardown.ts`.
 *
 * Endpoints:
 *
 *   POST /e2e/r2/lookup
 *     body: { bucket, key, contentType?, bodyHash }
 *     →    : { hit: true, response: UploadResult } | { hit: false }
 *
 *   POST /e2e/r2/record   (only honored when E2E_RECORD=1)
 *     body: { bucket, key, contentType?, bodyHash, bodySize, response: UploadResult }
 *     →    : { ok: true } | { ok: false, error }
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import {
  recordWithHash,
  tryReplay,
  tryReplayWithBodyHash,
  type UploadFingerprint,
} from '@/lib/storage/r2-recorder';
import type { UploadResult } from '@/lib/storage/buckets';
import { E2E_RECORDING } from '../recording-mode';

export const R2_MOCK_PORT = 4011;

let server: Server | null = null;

type LookupBody = UploadFingerprint & { bodyHash: string };
type RecordBody = UploadFingerprint & {
  bodyHash: string;
  bodySize: number;
  response: UploadResult;
};

// Reads + parses a JSON body from an internal sidecar request. The endpoints
// are only called by storage-cloudflare.ts in our own worker, so type-shape
// trust is appropriate here — Zod validation would be ceremony for code that
// can only be exercised by us.
// oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- trusted internal caller
async function readJson<T>(req: IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('error', reject);
    req.on('end', () => {
      try {
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- trusted internal caller
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
      } catch (err) {
        reject(err);
      }
    });
  });
}

function send(
  res: ServerResponse,
  status: number,
  body: Record<string, unknown>
): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (req.method !== 'POST')
    return send(res, 405, { error: 'method-not-allowed' });

  if (req.url === '/e2e/r2/lookup') {
    const fp = await readJson<LookupBody>(req);
    // Try unique-fingerprint hit first (no body hash needed); fall through to
    // hash-disambiguated lookup when multiple entries share the fingerprint.
    const initial = tryReplay({
      bucket: fp.bucket,
      key: fp.key,
      contentType: fp.contentType,
    });
    if (initial.type === 'hit')
      return send(res, 200, { hit: true, response: initial.response });
    if (initial.type === 'miss') return send(res, 200, { hit: false });
    const disambiguated = tryReplayWithBodyHash(
      { bucket: fp.bucket, key: fp.key, contentType: fp.contentType },
      fp.bodyHash
    );
    if (disambiguated)
      return send(res, 200, { hit: true, response: disambiguated });
    return send(res, 200, { hit: false });
  }

  if (req.url === '/e2e/r2/record') {
    if (!E2E_RECORDING)
      return send(res, 403, { ok: false, error: 'not-recording' });
    const body = await readJson<RecordBody>(req);
    recordWithHash(
      { bucket: body.bucket, key: body.key, contentType: body.contentType },
      body.bodyHash,
      body.bodySize,
      body.response
    );
    return send(res, 200, { ok: true });
  }

  send(res, 404, { error: 'not-found' });
}

export async function startR2MockServer(): Promise<void> {
  if (server) return;
  const next = createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      console.error('[r2-mock] handler error:', err);
      if (!res.headersSent) {
        // Do not leak full error details (including stack / internal paths)
        // over the network, even to localhost callers.
        send(res, 500, { error: 'internal error' });
      }
    });
  });
  server = next;
  await new Promise<void>((resolve) => {
    // Bind explicitly to localhost. Binding only to the port (as was done
    // previously) causes Node to listen on all interfaces (0.0.0.0 / ::),
    // making the mock server (including the record endpoint when
    // E2E_RECORD=1 is active) reachable from other machines on the network.
    next.listen(R2_MOCK_PORT, '127.0.0.1', () => {
      console.log(
        `[e2e] r2-mock server started at http://localhost:${R2_MOCK_PORT}`
      );
      resolve();
    });
  });
}

export async function stopR2MockServer(): Promise<void> {
  const current = server;
  if (!current) return;
  server = null;
  await new Promise<void>((resolve, reject) => {
    current.close((err) => (err ? reject(err) : resolve()));
  });
  console.log('[e2e] r2-mock server stopped');
}
