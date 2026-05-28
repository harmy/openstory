/**
 * Acceptance tests for the prompt-variants helpers.
 *
 * These exercise issue #620's acceptance criteria end-to-end against an
 * in-memory libSQL database with the real migrations applied:
 *   - Editing a prompt produces a `'user-edit'` row; the prior text is
 *     recoverable by reading the variant chain.
 *   - Regenerating a prompt produces a `'regenerated'` row with a populated
 *     `input_hash`.
 *   - The cached pointer (`frames.imagePrompt` / `motionPrompt` and the
 *     matching `*PromptInputHash`) is updated by the helper sequentially
 *     after the variant insert (not transactionally — see the helper
 *     docstring for the durability story).
 */

import type { Database } from '@/lib/db/client';
import { generateId } from '@/lib/db/id';
import {
  framePromptVariants,
  frames,
  sequenceMusicPromptVariants,
  sequences,
  styles,
  teams,
  user,
} from '@/lib/db/schema';
import { relations } from '@/lib/db/schema/relations';
import { type Client, createClient } from '@libsql/client';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';
import { createFramePromptVariantsMethods } from './frame-prompt-variants';
import { createSequenceMusicPromptVariantsMethods } from './sequence-music-prompt-variants';

let client: Client;
let db: Database;
let teamId = '';
let sequenceId = '';
let frameId = '';

async function seed() {
  await db.delete(framePromptVariants);
  await db.delete(sequenceMusicPromptVariants);
  await db.delete(frames);
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
  await db.insert(sequences).values({
    id: sequenceId,
    teamId,
    title: 'S',
    styleId: style.id,
  });
  const [frame] = await db
    .insert(frames)
    .values({ sequenceId, orderIndex: 0 })
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

describe('frame_prompt_variants helper', () => {
  it('user-edit with null inputHash appends a row and clears the cached hash', async () => {
    const methods = createFramePromptVariantsMethods(db);

    // Seed the cached column to mimic an existing AI-generated prompt.
    await db
      .update(frames)
      .set({
        imagePrompt: 'AI-generated prompt v1',
        visualPromptInputHash: 'hash-v1',
      })
      .where(eq(frames.id, frameId));

    // A user-edit recorded without an upstream hash (e.g., context was
    // uncomputable at write time) writes null to both the row and the cache.
    const variant = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'User edited prompt',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    expect(variant.source).toBe('user-edit');
    expect(variant.text).toBe('User edited prompt');
    expect(variant.inputHash).toBeNull();

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.imagePrompt).toBe('User edited prompt');
    expect(refreshed.visualPromptInputHash).toBeNull();
  });

  it('user-edit with a real inputHash stamps both the row and the cached column', async () => {
    const methods = createFramePromptVariantsMethods(db);

    await db
      .update(frames)
      .set({
        imagePrompt: 'AI-generated prompt v1',
        visualPromptInputHash: 'hash-v1',
      })
      .where(eq(frames.id, frameId));

    const variant = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'User edited prompt',
      source: 'user-edit',
      inputHash: 'hash-at-edit-time',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(variant.source).toBe('user-edit');
    expect(variant.inputHash).toBe('hash-at-edit-time');

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.imagePrompt).toBe('User edited prompt');
    expect(refreshed.visualPromptInputHash).toBe('hash-at-edit-time');
  });

  it('regenerated prompt populates input_hash on both the row and the cached column', async () => {
    const methods = createFramePromptVariantsMethods(db);

    const variant = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v2',
      source: 'regenerated',
      inputHash: 'context-hash-abc',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(variant.source).toBe('regenerated');
    expect(variant.inputHash).toBe('context-hash-abc');

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.imagePrompt).toBe('AI prompt v2');
    expect(refreshed.visualPromptInputHash).toBe('context-hash-abc');
  });

  it('preserves prior AI text in the variant chain after a user edit (recoverable history)', async () => {
    const methods = createFramePromptVariantsMethods(db);

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'User edited prompt',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    const history = await methods.listByFrame(frameId, 'visual');
    expect(history).toHaveLength(2);
    // Newest first.
    const [latest, prior] = history;
    if (!latest || !prior) throw new Error('test setup: history missing rows');
    expect(latest.source).toBe('user-edit');
    expect(prior.source).toBe('ai-generated');
    expect(prior.text).toBe('AI prompt v1');
    expect(prior.inputHash).toBe('context-hash-1');
  });

  it('ai-generated → regenerated → user-edit chain reflects the workflow source-discrimination flow', async () => {
    // Mirrors the scene-prompt workflow's decision: source = previous ?
    // 'regenerated' : 'ai-generated'. A regression that swaps the two would
    // mislabel every regeneration as a first generation (or vice versa) and
    // corrupt prompt history.
    const methods = createFramePromptVariantsMethods(db);

    const previousBeforeFirst = await methods.getLatest(frameId, 'visual');
    expect(previousBeforeFirst).toBeNull();
    const firstSource = previousBeforeFirst ? 'regenerated' : 'ai-generated';

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v1',
      source: firstSource,
      inputHash: 'hash-v1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const previousBeforeSecond = await methods.getLatest(frameId, 'visual');
    expect(previousBeforeSecond?.source).toBe('ai-generated');
    const secondSource = previousBeforeSecond ? 'regenerated' : 'ai-generated';

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v2',
      source: secondSource,
      inputHash: 'hash-v2',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'User polished it',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    const history = await methods.listByFrame(frameId, 'visual');
    expect(history.map((r) => r.source)).toEqual([
      'user-edit',
      'regenerated',
      'ai-generated',
    ]);

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    // Cached column reflects the latest write (user-edit) and the hash is
    // cleared since the cached value is no longer derived from upstream.
    expect(refreshed.imagePrompt).toBe('User polished it');
    expect(refreshed.visualPromptInputHash).toBeNull();
  });

  it('AI write is idempotent on (frame, type, input_hash) — a retry returns the existing row', async () => {
    const methods = createFramePromptVariantsMethods(db);

    const first = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const retried = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(retried.id).toBe(first.id);

    const history = await methods.listByFrame(frameId, 'visual');
    expect(history).toHaveLength(1);
  });

  it('force-regen at the same input_hash appends a null-hash history row with the new text and keeps the cached hash tracking the live context', async () => {
    // Mirrors the user-driven "Regenerate Prompt" path: the LLM is invoked
    // again against unchanged upstream inputs, so the new completion's hash
    // collides with the existing row. The helper must still record the new
    // text in history (otherwise the user's regenerated prompt would be
    // silently lost) while keeping the cached `*_prompt_input_hash` column
    // tracking the real upstream hash so staleness detection stays correct.
    const methods = createFramePromptVariantsMethods(db);

    const first = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const forced = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'Fresh LLM completion against same inputs',
      source: 'regenerated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    // A distinct row was inserted (not the existing one returned verbatim).
    expect(forced.id).not.toBe(first.id);
    // Bypasses the partial unique index via null `input_hash`.
    expect(forced.inputHash).toBeNull();
    expect(forced.source).toBe('regenerated');
    expect(forced.text).toBe('Fresh LLM completion against same inputs');

    const history = await methods.listByFrame(frameId, 'visual');
    expect(history).toHaveLength(2);
    const [latest, prior] = history;
    if (!latest || !prior) throw new Error('test setup: history missing rows');
    expect(latest.text).toBe('Fresh LLM completion against same inputs');
    expect(prior.text).toBe('AI prompt v1');

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.imagePrompt).toBe(
      'Fresh LLM completion against same inputs'
    );
    // Cached hash still reflects the live upstream so staleness detection
    // doesn't fire spuriously after a force regeneration.
    expect(refreshed.visualPromptInputHash).toBe('context-hash-1');
  });

  it('idempotent retry of the same text at the same hash still de-dupes (does not fall through to the null-hash branch)', async () => {
    // Regression guard for the force-regen branch: it must only fire when
    // `existing.text !== input.text`. A genuine workflow step retry submits
    // the same text + same hash and should still collapse to one row.
    const methods = createFramePromptVariantsMethods(db);

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v1',
      source: 'regenerated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const history = await methods.listByFrame(frameId, 'visual');
    expect(history).toHaveLength(1);
  });

  it('a different input_hash produces a new row for the same frame+type', async () => {
    const methods = createFramePromptVariantsMethods(db);

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI v1',
      source: 'ai-generated',
      inputHash: 'hash-a',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI v2',
      source: 'regenerated',
      inputHash: 'hash-b',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const history = await methods.listByFrame(frameId, 'visual');
    expect(history).toHaveLength(2);
  });

  it('motion prompts use the motionPrompt cached column independently of visual', async () => {
    const methods = createFramePromptVariantsMethods(db);

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'visual',
      source: 'ai-generated',
      inputHash: 'visual-hash',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    await methods.write({
      frameId,
      promptType: 'motion',
      text: 'motion',
      source: 'ai-generated',
      inputHash: 'motion-hash',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.imagePrompt).toBe('visual');
    expect(refreshed.motionPrompt).toBe('motion');
    expect(refreshed.visualPromptInputHash).toBe('visual-hash');
    expect(refreshed.motionPromptInputHash).toBe('motion-hash');
  });

  it('getByIdForFrame refuses to return a sibling frame variant (cross-frame guard)', async () => {
    // Restore handlers rely on this guard to refuse a `variantId` that
    // belongs to a different frame in the same sequence — without it, a
    // user could restore frame A's prompt onto frame B by passing the wrong
    // variantId. The frame-access middleware only checks the parent frame.
    const methods = createFramePromptVariantsMethods(db);

    const [siblingFrame] = await db
      .insert(frames)
      .values({ sequenceId, orderIndex: 1 })
      .returning();
    if (!siblingFrame)
      throw new Error('test setup: sibling frame insert returned nothing');

    const ownVariant = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'belongs to frame A',
      source: 'ai-generated',
      inputHash: 'hash-A',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    // Lookup with the sibling frame's id must not succeed.
    const wrongFrame = await methods.getByIdForFrame(
      ownVariant.id,
      siblingFrame.id
    );
    expect(wrongFrame).toBeNull();

    // Sanity: the same lookup with the owning frame's id does return it.
    const rightFrame = await methods.getByIdForFrame(ownVariant.id, frameId);
    expect(rightFrame?.id).toBe(ownVariant.id);
  });

  it('restored row carries the source variant input_hash so staleness keeps tracking the original upstream context', async () => {
    const methods = createFramePromptVariantsMethods(db);

    // Original AI-generated prompt with a stored hash.
    const original = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    // User then edits the prompt, but the upstream context wasn't
    // computable at edit time — both the row and the cached column go
    // null. The restore-from-AI flow below must still re-populate the
    // cached hash from the source row.
    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'User edited prompt',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    // Restoring the original AI prompt must re-populate the cached hash so
    // the staleness check resumes detecting upstream drift. A regression
    // that drops the hash here silently disables staleness forever.
    const restored = await methods.write({
      frameId,
      promptType: 'visual',
      text: original.text,
      components: original.components,
      parameters: original.parameters,
      source: 'restored',
      inputHash: original.inputHash,
      analysisModel: original.analysisModel,
    });
    expect(restored.inputHash).toBe('context-hash-1');
    // Restore must append a NEW history row, not silently return the source
    // AI row when its hash is still unique on the frame. The previous unique
    // index keyed on (frame, type, input_hash) collapsed restore-of-existing-
    // hash into onConflictDoNothing, dropping the audit row.
    expect(restored.id).not.toBe(original.id);
    expect(restored.source).toBe('restored');

    const history = await methods.listByFrame(frameId, 'visual');
    expect(history).toHaveLength(3);
    expect(history.map((r) => r.source)).toEqual([
      'restored',
      'user-edit',
      'ai-generated',
    ]);

    const [refreshed] = await db
      .select()
      .from(frames)
      .where(eq(frames.id, frameId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.imagePrompt).toBe('AI prompt v1');
    expect(refreshed.visualPromptInputHash).toBe('context-hash-1');
  });

  it('restoring an AI prompt that is currently live still appends a restored row (audit trail)', async () => {
    // Without the partial-index `source != 'restored'` exclusion, this case
    // hit onConflictDoNothing and silently returned the original AI row.
    const methods = createFramePromptVariantsMethods(db);

    const original = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt v1',
      source: 'ai-generated',
      inputHash: 'context-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const restored = await methods.write({
      frameId,
      promptType: 'visual',
      text: original.text,
      components: original.components,
      parameters: original.parameters,
      source: 'restored',
      inputHash: original.inputHash,
      analysisModel: original.analysisModel,
    });

    expect(restored.id).not.toBe(original.id);
    expect(restored.source).toBe('restored');
    expect(restored.inputHash).toBe('context-hash-1');

    const history = await methods.listByFrame(frameId, 'visual');
    expect(history).toHaveLength(2);
  });

  it('restored row from a user-edit source carries null hash (no staleness opinion to forward)', async () => {
    const methods = createFramePromptVariantsMethods(db);

    const userEdit = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'Hand-written prompt',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    // Restoring a user-edit must not synthesize a hash out of nothing —
    // the source had none, so the restored row keeps null.
    const restored = await methods.write({
      frameId,
      promptType: 'visual',
      text: userEdit.text,
      components: userEdit.components,
      parameters: userEdit.parameters,
      source: 'restored',
      inputHash: userEdit.inputHash,
      analysisModel: userEdit.analysisModel,
    });
    expect(restored.inputHash).toBeNull();
    expect(restored.analysisModel).toBeNull();
  });

  it('getLatestWithInputHash skips null-hash user-edits and returns the most recent hashed row', async () => {
    const methods = createFramePromptVariantsMethods(db);

    // 1) An AI prompt with a real hash.
    const ai = await methods.write({
      frameId,
      promptType: 'visual',
      text: 'AI prompt',
      source: 'ai-generated',
      inputHash: 'ai-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });
    // 2) A later user-edit with no upstream context (null hash).
    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'Hand-typed prompt',
      source: 'user-edit',
      inputHash: null,
      analysisModel: null,
    });

    // getLatest returns the most recent row regardless of hash.
    const latest = await methods.getLatest(frameId, 'visual');
    expect(latest?.inputHash).toBeNull();

    // getLatestWithInputHash skips the user-edit and returns the AI row.
    const latestHashed = await methods.getLatestWithInputHash(
      frameId,
      'visual'
    );
    expect(latestHashed?.id).toBe(ai.id);
    expect(latestHashed?.inputHash).toBe('ai-hash-1');
  });

  it('getLatestWithInputHash isolates by promptType (visual vs motion)', async () => {
    const methods = createFramePromptVariantsMethods(db);

    await methods.write({
      frameId,
      promptType: 'visual',
      text: 'Visual prompt',
      source: 'ai-generated',
      inputHash: 'visual-hash',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const motionMatch = await methods.getLatestWithInputHash(frameId, 'motion');
    expect(motionMatch).toBeNull();
  });
});

describe('sequence_music_prompt_variants helper', () => {
  it('user-edit clears musicPromptInputHash and overwrites the cached prompt/tags', async () => {
    const methods = createSequenceMusicPromptVariantsMethods(db);

    await db
      .update(sequences)
      .set({
        musicPrompt: 'AI music v1',
        musicTags: 'epic,cinematic',
        musicPromptInputHash: 'music-hash-1',
      })
      .where(eq(sequences.id, sequenceId));

    const variant = await methods.write({
      sequenceId,
      prompt: 'User edited music prompt',
      tags: 'rock,fast',
      source: 'user-edit',
    });

    expect(variant.source).toBe('user-edit');

    const [refreshed] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.musicPrompt).toBe('User edited music prompt');
    expect(refreshed.musicTags).toBe('rock,fast');
    expect(refreshed.musicPromptInputHash).toBeNull();
  });

  it('ai-generated → regenerated chain on music variants mirrors the music-prompt workflow flow', async () => {
    const methods = createSequenceMusicPromptVariantsMethods(db);

    const previousBeforeFirst = await methods.getLatest(sequenceId);
    expect(previousBeforeFirst).toBeNull();
    const firstSource = previousBeforeFirst ? 'regenerated' : 'ai-generated';

    await methods.write({
      sequenceId,
      prompt: 'AI music v1',
      tags: 'epic',
      source: firstSource,
      inputHash: 'music-hash-v1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const previousBeforeSecond = await methods.getLatest(sequenceId);
    expect(previousBeforeSecond?.source).toBe('ai-generated');
    const secondSource = previousBeforeSecond ? 'regenerated' : 'ai-generated';

    await methods.write({
      sequenceId,
      prompt: 'AI music v2',
      tags: 'epic,driving',
      source: secondSource,
      inputHash: 'music-hash-v2',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const history = await methods.listBySequence(sequenceId);
    expect(history.map((r) => r.source)).toEqual([
      'regenerated',
      'ai-generated',
    ]);

    const [refreshed] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.musicPrompt).toBe('AI music v2');
    expect(refreshed.musicPromptInputHash).toBe('music-hash-v2');
  });

  it('AI music write is idempotent on (sequence, input_hash) — a retry returns the existing row', async () => {
    const methods = createSequenceMusicPromptVariantsMethods(db);

    const first = await methods.write({
      sequenceId,
      prompt: 'AI music',
      tags: 'epic',
      source: 'ai-generated',
      inputHash: 'music-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const retried = await methods.write({
      sequenceId,
      prompt: 'AI music',
      tags: 'epic',
      source: 'ai-generated',
      inputHash: 'music-hash-1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    expect(retried.id).toBe(first.id);

    const history = await methods.listBySequence(sequenceId);
    expect(history).toHaveLength(1);
  });

  it('regenerated music prompt populates the input hash on the sequence row', async () => {
    const methods = createSequenceMusicPromptVariantsMethods(db);

    await methods.write({
      sequenceId,
      prompt: 'AI music v2',
      tags: 'epic',
      source: 'regenerated',
      inputHash: 'music-context-hash',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const [refreshed] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.musicPrompt).toBe('AI music v2');
    expect(refreshed.musicPromptInputHash).toBe('music-context-hash');
  });

  it('getByIdForSequence refuses to return a sibling sequence variant (cross-sequence guard)', async () => {
    const methods = createSequenceMusicPromptVariantsMethods(db);

    // Reuse the seeded style so we can satisfy the not-null styleId on
    // sequences without duplicating the style fixture here.
    const [seededSequence] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!seededSequence)
      throw new Error('test setup: seeded sequence not found');
    const otherSequenceId = generateId();
    await db.insert(sequences).values({
      id: otherSequenceId,
      teamId,
      title: 'Other',
      styleId: seededSequence.styleId,
    });

    const ownVariant = await methods.write({
      sequenceId,
      prompt: 'belongs to sequence A',
      tags: 'epic',
      source: 'ai-generated',
      inputHash: 'music-hash-A',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    const wrongSequence = await methods.getByIdForSequence(
      ownVariant.id,
      otherSequenceId
    );
    expect(wrongSequence).toBeNull();

    const rightSequence = await methods.getByIdForSequence(
      ownVariant.id,
      sequenceId
    );
    expect(rightSequence?.id).toBe(ownVariant.id);
  });

  it('restored music row carries the source variant input_hash so sequence staleness keeps tracking upstream context', async () => {
    const methods = createSequenceMusicPromptVariantsMethods(db);

    const original = await methods.write({
      sequenceId,
      prompt: 'AI music v1',
      tags: 'epic',
      source: 'ai-generated',
      inputHash: 'music-hash-v1',
      analysisModel: 'anthropic/claude-haiku-4.5',
    });

    await methods.write({
      sequenceId,
      prompt: 'User edit',
      tags: 'rock',
      source: 'user-edit',
    });

    const restored = await methods.write({
      sequenceId,
      prompt: original.prompt,
      tags: original.tags,
      source: 'restored',
      inputHash: original.inputHash,
      analysisModel: original.analysisModel,
    });
    expect(restored.inputHash).toBe('music-hash-v1');
    // Restore must append a new audit row even when the source AI hash is
    // still unique on the sequence.
    expect(restored.id).not.toBe(original.id);
    expect(restored.source).toBe('restored');

    const history = await methods.listBySequence(sequenceId);
    expect(history).toHaveLength(3);
    expect(history.map((r) => r.source)).toEqual([
      'restored',
      'user-edit',
      'ai-generated',
    ]);

    const [refreshed] = await db
      .select()
      .from(sequences)
      .where(eq(sequences.id, sequenceId));
    if (!refreshed) throw new Error('test setup: refresh failed');
    expect(refreshed.musicPrompt).toBe('AI music v1');
    expect(refreshed.musicPromptInputHash).toBe('music-hash-v1');
  });
});
