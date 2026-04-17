/**
 * Streaming Scene Parser
 *
 * Incrementally extracts complete scenes from a partial JSON stream.
 * Uses partial-json to parse incomplete LLM output and emits events
 * as new scenes become fully parseable.
 */

import { parse } from 'partial-json';
import { z } from 'zod';
import {
  type CharacterBibleEntry,
  characterBibleEntrySchema,
  type LocationBibleEntry,
  locationBibleEntrySchema,
  originalScriptSchema,
  sceneMetadataSchema,
} from './scene-analysis.schema';

/**
 * Minimal scene schema for completeness detection.
 * A scene is "complete" when all required fields are present and valid.
 */
const sceneSplittingSceneSchema = z.object({
  sceneId: z.string(),
  sceneNumber: z.number(),
  originalScript: originalScriptSchema,
  metadata: sceneMetadataSchema,
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

      let raw: unknown;
      try {
        raw = parse(stripCodeFences(accumulated));
      } catch {
        return events;
      }

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

      // Check for character bible (streams after scenes)
      if (!characterBibleEmitted && Array.isArray(raw.characterBible)) {
        const parsed = z
          .array(characterBibleEntrySchema)
          .safeParse(raw.characterBible);
        if (parsed.success && parsed.data.length > 0) {
          characterBibleEmitted = true;
          events.push({ type: 'characterBible', bible: parsed.data });
        }
      }

      // Check for location bible (streams after scenes)
      if (!locationBibleEmitted && Array.isArray(raw.locationBible)) {
        const parsed = z
          .array(locationBibleEntrySchema)
          .safeParse(raw.locationBible);
        if (parsed.success && parsed.data.length > 0) {
          locationBibleEmitted = true;
          events.push({ type: 'locationBible', bible: parsed.data });
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
