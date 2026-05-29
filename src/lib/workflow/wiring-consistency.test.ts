/**
 * Wiring consistency checks for Cloudflare Workflows.
 *
 * Every workflow needs entries in four places:
 *
 *   1. `wrangler.jsonc` workflows[]   — declares the runtime binding so
 *                                       miniflare/CF actually creates it
 *   2. `src/server.ts` re-export      — keeps the class in the Worker bundle
 *   3. `src/lib/workflow/types.ts`    — adds the binding to `CloudflareEnv`
 *                                       so TypeScript can see it
 *   4. `src/lib/workflow/trigger-bindings.ts` `TRIGGER_TO_BINDING`
 *                                     — maps the trigger path that
 *                                       `triggerWorkflow('/foo', ...)` uses
 *                                       to the env binding name
 *
 * Missing any one of these silently breaks the workflow:
 *   - wrangler.jsonc missing → "env binding is missing or not a Workflow"
 *   - server.ts missing → wrangler can't find the class on deploy
 *   - types.ts missing → typecheck blocks `this.env.X`
 *   - trigger map missing → "no workflow binding mapped for trigger path"
 *
 * These tests fail loudly the next time someone adds a workflow and forgets
 * one of the four steps.
 *
 * Plus one structural check on instance IDs: every output of `buildInstanceId`
 * must match CF's `^[a-zA-Z0-9_-]+$` rule.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { buildInstanceId } from '@/lib/workflow/instance-id';

const WRANGLER_PATH = 'wrangler.jsonc';
const SERVER_PATH = 'src/server.ts';
const TYPES_PATH = 'src/lib/workflow/types.ts';
const TRIGGER_BINDINGS_PATH = 'src/lib/workflow/trigger-bindings.ts';

type WranglerWorkflowEntry = {
  name: string;
  binding: string;
  class_name: string;
};

function captureAll(text: string, regex: RegExp): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(regex)) {
    const captured = m[1];
    if (captured) out.push(captured);
  }
  return out;
}

function parseWranglerWorkflows(): WranglerWorkflowEntry[] {
  // wrangler.jsonc uses JSONC (comments + trailing commas + unquoted keys
  // sometimes). Skip a real parser and regex out the workflow entries —
  // they follow a strict shape:
  //   { "name": "...", "binding": "...", "class_name": "..." }
  const text = readFileSync(WRANGLER_PATH, 'utf8');
  const block = text.match(/"workflows"\s*:\s*\[([\s\S]*?)\]/);
  const inner = block?.[1];
  if (!inner) return [];
  const entries: WranglerWorkflowEntry[] = [];
  const entryRegex =
    /"name"\s*:\s*"([^"]+)"\s*,\s*"binding"\s*:\s*"([^"]+)"\s*,\s*"class_name"\s*:\s*"([^"]+)"/g;
  for (const m of inner.matchAll(entryRegex)) {
    if (m[1] && m[2] && m[3]) {
      entries.push({ name: m[1], binding: m[2], class_name: m[3] });
    }
  }
  return entries;
}

function extractBindingNamesFromTypes(): Set<string> {
  const text = readFileSync(TYPES_PATH, 'utf8');
  // Match lines like `  IMAGE_WORKFLOW?: Workflow<unknown>;` inside the
  // CloudflareEnv type. Loose match — any `<NAME>?: Workflow<...>` shape.
  return new Set(captureAll(text, /([A-Z][A-Z0-9_]+)\??:\s*Workflow</g));
}

function extractTriggerMapValues(): Set<string> {
  const text = readFileSync(TRIGGER_BINDINGS_PATH, 'utf8');
  const block = text.match(/TRIGGER_TO_BINDING[^=]*=\s*\{([\s\S]*?)\};/);
  const inner = block?.[1];
  if (!inner) {
    throw new Error(
      'Could not find TRIGGER_TO_BINDING block in trigger-bindings.ts'
    );
  }
  return new Set(captureAll(inner, /'([A-Z][A-Z0-9_]+)'/g));
}

function extractServerExports(): Set<string> {
  const text = readFileSync(SERVER_PATH, 'utf8');
  // `export { ClassName } from '@/lib/workflows/...';`
  return new Set(
    captureAll(
      text,
      /export\s*\{\s*([A-Za-z0-9_]+)\s*\}\s*from\s*['"]@\/lib\/workflows\//g
    )
  );
}

describe('CF workflow wiring is consistent across all four declaration sites', () => {
  const wranglerWorkflows = parseWranglerWorkflows();
  const wranglerBindings = new Set(wranglerWorkflows.map((w) => w.binding));
  const wranglerClasses = new Set(wranglerWorkflows.map((w) => w.class_name));
  const typeBindings = extractBindingNamesFromTypes();
  const triggerMapBindings = extractTriggerMapValues();
  const serverExports = extractServerExports();

  test('every wrangler binding is declared on CloudflareEnv', () => {
    const missing = [...wranglerBindings].filter((b) => !typeBindings.has(b));
    expect(missing).toEqual([]);
  });

  test('every wrangler binding has a matching server.ts re-export of its class', () => {
    const missing = wranglerWorkflows.filter(
      (w) => !serverExports.has(w.class_name)
    );
    expect(missing.map((w) => w.class_name)).toEqual([]);
  });

  test('every binding referenced by TRIGGER_TO_BINDING exists in wrangler.jsonc', () => {
    const missing = [...triggerMapBindings].filter(
      (b) => !wranglerBindings.has(b)
    );
    // Surface the actual missing binding names in the failure for fast fixup.
    expect(missing).toEqual([]);
  });

  test('every CloudflareEnv binding has either a TRIGGER_TO_BINDING entry or a comment-tracked exemption', () => {
    // Some bindings may legitimately not have a trigger path (e.g. only
    // invoked as Pattern 3 children from other workflows). For now, every
    // binding in types.ts that exists in wrangler.jsonc should also exist
    // in the trigger map — none of our ports are children-only today.
    const unrouted = [...wranglerBindings].filter(
      (b) => !triggerMapBindings.has(b)
    );
    expect(unrouted).toEqual([]);
  });

  test('every server.ts CF re-export has a matching wrangler workflow entry', () => {
    const orphaned = [...serverExports].filter(
      (cls) => !wranglerClasses.has(cls)
    );
    expect(orphaned).toEqual([]);
  });
});

describe('Pattern 3 childIds are CF-valid after sanitization', () => {
  // Mirror of the sanitizer inside spawnAndAwaitChild (private). If the
  // helper's sanitization regex ever changes, update this duplicate.
  const sanitize = (raw: string): string =>
    raw.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 100);
  const CF_VALID = /^[a-zA-Z0-9_-]+$/;

  // Catch the historical "colons in childId crash CF" footgun by sampling
  // the actual childId shapes our codebase passes.
  const realCallsiteIds = [
    'image:seq-123:frame-7',
    'image:seq-123:frame-7:nano_banana_2',
    'motion:seq-123:frame-7',
    'analyze-script:01KS23834FEGDBN8074VVPR3Q8',
    'character-sheet:recast:01KS23',
    'regenerate-frames:character:01KS23',
    'music-prompt:01KS23',
    'motion-prompts:01KS23',
  ];

  for (const id of realCallsiteIds) {
    test(`childId ${id} sanitizes to a CF-valid ID`, () => {
      const sanitized = sanitize(id);
      expect(sanitized).toMatch(CF_VALID);
      expect(sanitized.length).toBeLessThanOrEqual(100);
    });
  }
});

describe('buildInstanceId always emits CF-valid IDs', () => {
  const CF_VALID = /^[a-zA-Z0-9_-]+$/;

  const cases: Array<{ env: string; suffix: string }> = [
    { env: 'https://openstory.so', suffix: '01KS23834FEGDBN8074VVPR3Q8' },
    { env: 'https://pr-42.openstory.dev', suffix: 'seq-123:frame.7' },
    { env: '', suffix: 'a/b/c*d e' },
    { env: 'https://openstory.so', suffix: 'image:seq-123:frame-7:variant.0' },
  ];

  for (const { env, suffix } of cases) {
    test(`env=${env || 'unset'} suffix=${suffix}`, () => {
      const id = buildInstanceId({
        env: { VITE_APP_URL: env || undefined },
        workflowName: 'image',
        suffix,
      });
      expect(id).toMatch(CF_VALID);
      expect(id.length).toBeLessThanOrEqual(100);
    });
  }
});
