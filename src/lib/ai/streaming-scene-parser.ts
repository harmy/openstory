/**
 * Streaming Scene Parser
 *
 * Incrementally extracts complete scenes from a partial JSON stream.
 * Uses @tanstack/ai's parsePartialJSON to parse incomplete LLM output
 * and emits events as new scenes become fully parseable.
 */

import { parsePartialJSON } from '@tanstack/ai';
import { z } from 'zod';
import {
  type CharacterBibleEntry,
  characterBibleEntrySchema,
  dialogueLineSchema,
  type LocationBibleEntry,
  locationBibleEntrySchema,
} from './scene-analysis.schema';

/**
 * Lenient, default-filling scene schema for streaming completeness detection.
 *
 * The canonical scene-analysis schemas are now STRICT (no `.catch()`) so they
 * compile to a tight structured-output grammar (see the note in
 * `scene-analysis.schema.ts`). But this parser runs against PARTIAL mid-stream
 * JSON: it must accept a scene as soon as its `originalScript` / `metadata`
 * keys appear and COMPLETE the not-yet-streamed fields with defaults, so a
 * scene can be shown — and upserted as a full `Scene` — before its trailing
 * fields arrive. We therefore keep the lenient `.catch()` defaults LOCAL here
 * rather than re-introducing them into the strict schemas. The resulting
 * output type still matches `Scene` (every field present), so emitted scenes
 * remain assignable for `frames.upsert`.
 *
 * `originalScript` and `metadata` are required KEYS (a scene missing either is
 * "not complete yet"), but their contents are defaulted — matching the prior
 * `.catch()`-driven behaviour and the parser's tests.
 */
const lenientOriginalScript = z.object({
  extract: z.string().catch(''),
  dialogue: z.array(dialogueLineSchema).catch([]),
});

const lenientMetadata = z.object({
  title: z.string().catch('Untitled Scene'),
  durationSeconds: z.number().catch(3),
  location: z.string().catch(''),
  timeOfDay: z.string().catch(''),
  storyBeat: z.string().catch(''),
});

// Scene-split now emits `continuity` per scene (membership moved upstream, #867).
// It often streams in after `originalScript`/`metadata`, so every field defaults
// — a scene is still "complete enough" to preview before its continuity lands,
// and the strict reconcile parse carries the final value onto the frame.
const lenientContinuity = z
  .object({
    characterTags: z.array(z.string()).catch([]),
    environmentTag: z.string().catch(''),
    elementTags: z.array(z.string()).nullish().catch(null),
    colorPalette: z.string().catch(''),
    lightingSetup: z.string().catch(''),
    styleTag: z.string().catch(''),
  })
  .catch({
    characterTags: [],
    environmentTag: '',
    elementTags: null,
    colorPalette: '',
    lightingSetup: '',
    styleTag: '',
  });

const sceneSplittingSceneSchema = z.object({
  sceneId: z.string(),
  sceneNumber: z.number(),
  originalScript: lenientOriginalScript,
  metadata: lenientMetadata,
  continuity: lenientContinuity,
});

export type SceneSplittingScene = z.infer<typeof sceneSplittingSceneSchema>;

export type StreamedSceneEvent =
  | { type: 'title'; title: string }
  | { type: 'scene'; scene: SceneSplittingScene; index: number }
  | { type: 'scene:updated'; scene: SceneSplittingScene; index: number }
  | { type: 'characterBible'; bible: CharacterBibleEntry[] }
  | { type: 'locationBible'; bible: LocationBibleEntry[] };

/**
 * Strip markdown code fences that some models wrap around JSON output.
 * Handles ```json, ```, and leading/trailing whitespace.
 */
export function stripCodeFences(text: string): string {
  return text.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Parse each array element against `schema`, keeping only the ones that fully
 * validate. Used for mid-stream bible arrays where the trailing entry is often
 * still partial — we emit the entries that have completed so far.
 */
function collectComplete<T>(items: unknown[], schema: z.ZodType<T>): T[] {
  const out: T[] = [];
  for (const item of items) {
    const result = schema.safeParse(item);
    if (result.success) out.push(result.data);
  }
  return out;
}

export function createStreamingSceneParser() {
  let lastEmittedSceneCount = 0;
  let titleEmitted = false;
  let characterBibleEmitted = false;
  let locationBibleEmitted = false;
  let emittedTitles: Map<number, string> = new Map();

  return {
    /**
     * Feed accumulated LLM text and get back any new events since last feed.
     * Returns an empty array if no new scenes or title are available.
     */
    feed(accumulated: string): StreamedSceneEvent[] {
      const events: StreamedSceneEvent[] = [];

      const raw = parsePartialJSON(stripCodeFences(accumulated));
      if (raw === undefined) return events;

      if (!isRecord(raw)) return events;

      // Check for title
      if (!titleEmitted) {
        const pm = raw.projectMetadata;
        if (
          isRecord(pm) &&
          typeof pm.title === 'string' &&
          pm.title.length > 0
        ) {
          titleEmitted = true;
          events.push({ type: 'title', title: pm.title });
        }
      }

      // Check for new complete scenes
      const scenes = raw.scenes;
      if (!Array.isArray(scenes)) return events;

      // Check for updates to previously emitted scenes
      for (let i = 0; i < lastEmittedSceneCount && i < scenes.length; i++) {
        const result = sceneSplittingSceneSchema.safeParse(scenes[i]);
        if (result.success) {
          const currentTitle = result.data.metadata.title || '';
          if (currentTitle !== emittedTitles.get(i)) {
            emittedTitles.set(i, currentTitle);
            events.push({
              type: 'scene:updated',
              scene: result.data,
              index: i,
            });
          }
        }
      }

      for (let i = lastEmittedSceneCount; i < scenes.length; i++) {
        const result = sceneSplittingSceneSchema.safeParse(scenes[i]);
        if (result.success) {
          emittedTitles.set(i, result.data.metadata.title || '');
          events.push({ type: 'scene', scene: result.data, index: i });
          lastEmittedSceneCount = i + 1;
        } else {
          // Stop at first incomplete scene — subsequent ones can't be complete yet
          break;
        }
      }

      // Check for character bible (streams after scenes). The canonical entry
      // schema is strict, so we collect only the entries that have fully
      // streamed (dropping a trailing partial one) rather than requiring the
      // whole array to validate — this keeps the eager mid-stream emit.
      if (!characterBibleEmitted && Array.isArray(raw.characterBible)) {
        const complete = collectComplete(
          raw.characterBible,
          characterBibleEntrySchema
        );
        if (complete.length > 0) {
          characterBibleEmitted = true;
          events.push({ type: 'characterBible', bible: complete });
        }
      }

      // Check for location bible (streams after scenes)
      if (!locationBibleEmitted && Array.isArray(raw.locationBible)) {
        const complete = collectComplete(
          raw.locationBible,
          locationBibleEntrySchema
        );
        if (complete.length > 0) {
          locationBibleEmitted = true;
          events.push({ type: 'locationBible', bible: complete });
        }
      }

      return events;
    },

    /** Reset parser state (useful for testing). */
    reset() {
      lastEmittedSceneCount = 0;
      titleEmitted = false;
      characterBibleEmitted = false;
      locationBibleEmitted = false;
      emittedTitles = new Map();
    },
  };
}
