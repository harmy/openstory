/**
 * fal.ai mock handler mounted on the aimock server.
 *
 * Implements aimock's `Mountable` interface so a single LLMock instance
 * serves both LLM (OpenRouter) and fal.ai traffic.
 *
 * - Replay: matches recorded JSON fixtures keyed by target host, method, path,
 *   and request body hash.
 * - Record: when FAL_RECORD=true, forwards to real fal.ai using FAL_KEY,
 *   writes the response to disk, then returns it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type * as http from 'node:http';
import { resolve } from 'node:path';

type FixtureRecord = {
  request: {
    targetHost: string;
    method: string;
    pathname: string;
    bodyHash: string;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
};

const FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures/recorded/fal');

function ensureFixtureDir(): void {
  if (!existsSync(FIXTURE_DIR)) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
  }
}

function hashBody(body: string): string {
  return createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function safeFilename(parts: string[]): string {
  return parts
    .join('__')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/-+/g, '-');
}

function fixturePath(record: FixtureRecord['request']): string {
  const name = safeFilename([
    record.targetHost,
    record.method,
    record.pathname,
    record.bodyHash,
  ]);
  return resolve(FIXTURE_DIR, `${name}.json`);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () =>
      resolveBody(Buffer.concat(chunks as Uint8Array[]).toString('utf8'))
    );
    req.on('error', reject);
  });
}

async function forwardToFal(
  targetHost: string,
  pathname: string,
  search: string,
  method: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const falKey = process.env.FAL_KEY;
  if (!falKey || falKey === 'test-mock-key') {
    throw new Error(
      'FAL_RECORD=true requires a real FAL_KEY (not "test-mock-key")'
    );
  }

  const url = `https://${targetHost}${pathname}${search}`;
  const upstreamHeaders: Record<string, string> = {
    ...headers,
    Authorization: `Key ${falKey}`,
  };
  delete upstreamHeaders.host;
  delete upstreamHeaders['x-fal-target-host'];
  delete upstreamHeaders['content-length'];

  const init: RequestInit = {
    method,
    headers: upstreamHeaders,
  };
  if (method !== 'GET' && method !== 'HEAD' && body) {
    init.body = body;
  }

  const response = await fetch(url, init);
  const responseBody = await response.text();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    status: response.status,
    headers: responseHeaders,
    body: responseBody,
  };
}

export function createFalHandler() {
  ensureFixtureDir();

  return {
    async handleRequest(
      req: http.IncomingMessage,
      res: http.ServerResponse,
      pathname: string
    ): Promise<boolean> {
      // aimock strips the mount prefix before dispatching, so `pathname`
      // here is the original fal path (e.g. "/fal-ai/flux/run").
      const targetHostHeader = req.headers['x-fal-target-host'];
      const targetHost =
        typeof targetHostHeader === 'string' ? targetHostHeader : 'fal.run';
      const method = req.method ?? 'GET';
      const falPath = pathname || '/';
      const url = new URL(req.url ?? '/', 'http://localhost');
      const search = url.search;

      const rawBody = await readBody(req);
      const bodyHash = hashBody(rawBody);

      const requestKey: FixtureRecord['request'] = {
        targetHost,
        method,
        pathname: falPath,
        bodyHash,
      };

      const filePath = fixturePath(requestKey);
      const recording = process.env.FAL_RECORD === 'true';

      if (recording) {
        const headers = Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(',') : (v ?? ''),
          ])
        );
        const upstream = await forwardToFal(
          targetHost,
          falPath,
          search,
          method,
          headers,
          rawBody
        );
        const record: FixtureRecord = {
          request: requestKey,
          response: {
            status: upstream.status,
            headers: upstream.headers,
            body: tryParseJson(upstream.body),
          },
        };
        writeFileSync(filePath, JSON.stringify(record, null, 2));
        writeResponse(res, upstream.status, upstream.headers, upstream.body);
        return true;
      }

      if (!existsSync(filePath)) {
        const message = `[fal-mock] No fixture for ${targetHost} ${method} ${falPath} (hash ${bodyHash}). Re-record with FAL_RECORD=true.`;
        console.warn(message);
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: message }));
        return true;
      }

      const fixture: FixtureRecord = JSON.parse(readFileSync(filePath, 'utf8'));
      const body =
        typeof fixture.response.body === 'string'
          ? fixture.response.body
          : JSON.stringify(fixture.response.body);
      writeResponse(
        res,
        fixture.response.status,
        fixture.response.headers,
        body
      );
      return true;
    },
  };
}

function writeResponse(
  res: http.ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string
): void {
  res.statusCode = status;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-length') continue;
    if (key.toLowerCase() === 'transfer-encoding') continue;
    res.setHeader(key, value);
  }
  res.end(body);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
