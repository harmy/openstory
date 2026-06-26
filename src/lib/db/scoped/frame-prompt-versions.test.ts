/**
 * Acceptance tests for the frame prompt-versions helper (image / visual prompt
 * history). Exercised against an in-memory libSQL database with the real
 * migrations applied — the same harness as shot-prompt-versions.test.ts.
 *
 * Covers the write dedupe / force-regen contract (including the regression
 * where a user-edit whose hash collides with an existing row silently dropped
 * the edit), the restore (`select`) repoint + atomic `prompt.selected` event,
 * and the cross-frame ownership guard.
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  framePromptVersions,
  frames,
  sequenceEvents,
  sequences,
  shots,
  styles,
  teams,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createFramePromptVersionsMethods } from './frame-prompt-versions';

let client: Client;
let db: Database;
let teamId = '';
let sequenceId = '';
let shotId = '';
let frameId = '';

async function seed() {
  await db.delete(sequenceEvents);
  await db.delete(framePromptVersions);
  await db.delete(frames);
  await db.delete(shots);
  await db.delete(sequences);
  await db.delete(styles);
  await db.delete(teams);
  await db.delete(user);

  teamId = generateId();
  sequenceId = generateId();

  await db.insert(teams).values({ id: teamId, name: 'T', slug: 't' });
  const [style] = await db
    .insert(styles)
    .values({
      teamId,
      name: 'default',
      config: {
        mood: 'neutral',
        artStyle: 'cinematic',
        lighting: 'natural',
        colorPalette: ['#000', '#fff'],
        cameraWork: 'static',
        referenceFilms: [],
        colorGrading: 'neutral',
      },
    })
    .returning();
  if (!style) throw new Error('test setup: style insert returned nothing');
  await db
    .insert(sequences)
    .values({ id: sequenceId, teamId, title: 'S', styleId: style.id });
  const [shot] = await db
    .insert(shots)
    .values({ sequenceId, orderIndex: 0 })
    .returning();
  if (!shot) throw new Error('test setup: shot insert returned nothing');
  shotId = shot.id;
  const [frame] = await db
    .insert(frames)
    .values({ shotId, sequenceId, orderIndex: 0, role: 'first' })
    .returning();
  if (!frame) throw new Error('test setup: frame insert returned nothing');
  frameId = frame.id;
}

beforeAll(async () => {
  client = createClient({ url: ':memory:' });
  db = drizzle({ client, relations });
  await migrate(db, { migrationsFolder: './drizzle/migrations' });
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await seed();
});

const HAIKU = 'anthropic/claude-haiku-4.5';

describe('framePromptVersions.write', () => {
  it('mirrors the version onto the frame (text, hash, selected pointer)', async () => {
    const m = createFramePromptVersionsMethods(db);

    const version = await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    expect(frame.imagePrompt).toBe('AI prompt v1');
    expect(frame.visualPromptInputHash).toBe('hash-1');
    expect(frame.selectedImagePromptVersionId).toBe(version.id);
  });

  it('AI write is idempotent on (frame, input_hash) — a retry returns the existing row', async () => {
    const m = createFramePromptVersionsMethods(db);
    const first = await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    const retried = await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    expect(retried.id).toBe(first.id);
    expect(await m.listByFrame(frameId)).toHaveLength(1);
  });

  it('force-regen at the same hash appends a null-hash row and keeps the cached hash tracking live context', async () => {
    const m = createFramePromptVersionsMethods(db);
    const first = await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    const forced = await m.write({
      frameId,
      text: 'Fresh completion against same inputs',
      source: 'regenerated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    expect(forced.id).not.toBe(first.id);
    expect(forced.inputHash).toBeNull();
    expect(forced.text).toBe('Fresh completion against same inputs');

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    expect(frame.imagePrompt).toBe('Fresh completion against same inputs');
    // Cached hash still tracks the live upstream so staleness doesn't fire.
    expect(frame.visualPromptInputHash).toBe('hash-1');
    expect(frame.selectedImagePromptVersionId).toBe(forced.id);
  });

  it('user-edit whose hash collides with an existing row STILL records the edit (regression)', async () => {
    // The bug: a user-edit carries the live upstream hash captured at edit
    // time. When the text was edited but upstream context is unchanged, that
    // hash matches the existing AI row, so the unique-index insert no-ops. The
    // helper previously fell through to `version = existing` (the OLD row) while
    // mirroring the NEW text onto the frame — the edit vanished from history and
    // the pointer disagreed with the cached prompt. It must append instead.
    const m = createFramePromptVersionsMethods(db);
    const ai = await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });

    const edit = await m.write({
      frameId,
      text: 'Hand-edited prompt',
      source: 'user-edit',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });

    // A distinct row was appended, carrying the new text.
    expect(edit.id).not.toBe(ai.id);
    expect(edit.source).toBe('user-edit');
    expect(edit.text).toBe('Hand-edited prompt');
    // Bypasses the partial unique index via null input_hash.
    expect(edit.inputHash).toBeNull();

    const history = await m.listByFrame(frameId);
    expect(history).toHaveLength(2);

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    // The pointer references the row whose text is mirrored — no divergence.
    expect(frame.imagePrompt).toBe('Hand-edited prompt');
    expect(frame.selectedImagePromptVersionId).toBe(edit.id);
    // Cached hash still tracks the live upstream context.
    expect(frame.visualPromptInputHash).toBe('hash-1');
  });

  it('idempotent retry of the same text at the same hash de-dupes (no spurious null-hash row)', async () => {
    const m = createFramePromptVersionsMethods(db);
    await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'regenerated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    expect(await m.listByFrame(frameId)).toHaveLength(1);
  });

  it('user-edit with null hash clears the cached hash', async () => {
    const m = createFramePromptVersionsMethods(db);
    await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    await m.write({
      frameId,
      text: 'Hand-typed prompt',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });
    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    expect(frame.imagePrompt).toBe('Hand-typed prompt');
    expect(frame.visualPromptInputHash).toBeNull();
  });
});

describe('framePromptVersions.select (restore)', () => {
  it('repoints the frame and appends a prompt.selected event with prevVersionId in one batch', async () => {
    const m = createFramePromptVersionsMethods(db);
    const v1 = await m.write({
      frameId,
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'hash-1',
      analysisModel: HAIKU,
    });
    const v2 = await m.write({
      frameId,
      text: 'AI prompt v2',
      source: 'regenerated',
      inputHash: 'hash-2',
      analysisModel: HAIKU,
    });
    // Frame now points at v2; restore v1.
    const actorId = generateId();
    await db.insert(user).values({ id: actorId, name: 'U', email: 'u@e.com' });

    const restored = await m.select(frameId, v1.id, { actorId });
    expect(restored.id).toBe(v1.id);

    const [frame] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!frame) throw new Error('test setup: refresh failed');
    expect(frame.imagePrompt).toBe('AI prompt v1');
    expect(frame.selectedImagePromptVersionId).toBe(v1.id);

    const events = await db
      .select()
      .from(sequenceEvents)
      .where(eq(sequenceEvents.kind, 'prompt.selected'));
    expect(events).toHaveLength(1);
    const [evt] = events;
    if (!evt) throw new Error('event missing');
    expect(evt.targetId).toBe(frameId);
    expect(evt.actorId).toBe(actorId);
    expect(evt.data).toMatchObject({ versionId: v1.id, prevVersionId: v2.id });
  });

  it('throws for a version that belongs to another frame (cross-frame guard)', async () => {
    const m = createFramePromptVersionsMethods(db);
    const [sibling] = await db
      .insert(frames)
      .values({ shotId, sequenceId, orderIndex: 1, role: 'last' })
      .returning();
    if (!sibling) throw new Error('test setup: sibling frame missing');
    const siblingVersion = await m.write({
      frameId: sibling.id,
      text: 'belongs to sibling',
      source: 'ai-generated',
      inputHash: 'hash-s',
      analysisModel: HAIKU,
    });

    await expect(
      m.select(frameId, siblingVersion.id, { actorId: null })
    ).rejects.toThrow(/not found for frame/);
  });
});

describe('framePromptVersions.getByIdForFrame', () => {
  it('refuses to return a sibling frame version (cross-frame guard)', async () => {
    const m = createFramePromptVersionsMethods(db);
    const [sibling] = await db
      .insert(frames)
      .values({ shotId, sequenceId, orderIndex: 1, role: 'last' })
      .returning();
    if (!sibling) throw new Error('test setup: sibling frame missing');
    const own = await m.write({
      frameId,
      text: 'belongs to frame A',
      source: 'ai-generated',
      inputHash: 'hash-A',
      analysisModel: HAIKU,
    });

    expect(await m.getByIdForFrame(own.id, sibling.id)).toBeNull();
    expect((await m.getByIdForFrame(own.id, frameId))?.id).toBe(own.id);
  });
});

describe('framePromptVersions.getLatestWithInputHash', () => {
  it('skips null-hash user-edits and returns the most recent hashed row', async () => {
    const m = createFramePromptVersionsMethods(db);
    const ai = await m.write({
      frameId,
      text: 'AI prompt',
      source: 'ai-generated',
      inputHash: 'ai-hash',
      analysisModel: HAIKU,
    });
    await m.write({
      frameId,
      text: 'Hand-typed',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });
    expect((await m.getLatest(frameId))?.inputHash).toBeNull();
    const hashed = await m.getLatestWithInputHash(frameId);
    expect(hashed?.id).toBe(ai.id);
    expect(hashed?.inputHash).toBe('ai-hash');
  });
});
