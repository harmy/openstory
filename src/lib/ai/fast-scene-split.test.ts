import { describe, expect, test } from 'vitest';
import { fastSceneSplit } from './fast-scene-split';

describe('fastSceneSplit', () => {
  test('splits screenplay with INT./EXT. headings', () => {
    const script = `INT. OFFICE - DAY

Sarah sits at her desk, typing.

SARAH
I can't believe this is happening.

EXT. PARKING LOT - NIGHT

Sarah walks to her car, looking over her shoulder.

INT. CAR - CONTINUOUS

She locks the doors and starts the engine.`;

    const scenes = fastSceneSplit(script);
    expect(scenes.length).toBe(3);
    const [first, second, third] = scenes;
    if (!first || !second || !third) {
      throw new Error('test setup: expected three scenes');
    }
    expect(first.metadata?.title).toBe('OFFICE');
    expect(second.metadata?.title).toBe('PARKING LOT');
    expect(third.metadata?.title).toBe('CAR');
    expect(first.sceneNumber).toBe(1);
    expect(second.sceneNumber).toBe(2);
  });

  test('splits on transitions (CUT TO, FADE IN)', () => {
    const script = `FADE IN:

A dark room. Thunder rumbles outside.

CUT TO:

A woman runs through the rain.

DISSOLVE TO:

Morning light fills the room.`;

    const scenes = fastSceneSplit(script);
    expect(scenes.length).toBeGreaterThanOrEqual(2);
  });

  test('handles prose-style scripts without markers', () => {
    const script = `The sun rises over the city skyline. Birds chirp in the distance.

John walks down the sidewalk, briefcase in hand. He checks his watch and picks up his pace.

At the coffee shop, he orders his usual. The barista smiles and starts making his drink.`;

    const scenes = fastSceneSplit(script);
    expect(scenes.length).toBeGreaterThanOrEqual(1);
    // Each scene should have content
    for (const scene of scenes) {
      expect(scene.originalScript.extract.trim().length).toBeGreaterThan(0);
    }
  });

  test('returns minimal Scene objects with required fields', () => {
    const script = `INT. KITCHEN - MORNING

Mom makes breakfast.`;

    const scenes = fastSceneSplit(script);
    expect(scenes.length).toBe(1);

    const scene = scenes[0];
    if (!scene) throw new Error('test setup: expected at least one scene');
    expect(scene.sceneId).toBeTruthy();
    expect(scene.sceneNumber).toBe(1);
    expect(scene.originalScript.extract).toContain('Mom makes breakfast');
    expect(scene.metadata?.title).toBe('KITCHEN');
    expect(scene.metadata?.durationSeconds).toBeGreaterThanOrEqual(3);
  });

  test('handles empty script', () => {
    const scenes = fastSceneSplit('');
    expect(scenes.length).toBe(0);
  });

  test('handles whitespace-only script', () => {
    const scenes = fastSceneSplit('   \n\n   \n  ');
    expect(scenes.length).toBe(0);
  });

  test('merges very small chunks with adjacent ones', () => {
    const script = `INT. ROOM - DAY

Hi.

EXT. GARDEN - DAY

She walks through the beautiful garden path, admiring the flowers and the butterflies.
The sun shines warmly as she reaches the old oak tree at the far end.`;

    const scenes = fastSceneSplit(script);
    // Small "Hi." chunk should be merged
    expect(scenes.length).toBeLessThanOrEqual(2);
  });

  test('caps very long scenes', () => {
    // Generate a script with many lines in one scene
    const longLines = Array.from(
      { length: 50 },
      (_, i) => `Line ${i + 1}: Some action happens here.`
    );
    const script = `INT. OFFICE - DAY\n${longLines.join('\n')}`;

    const scenes = fastSceneSplit(script, 20);
    // Should be split into multiple scenes due to maxLinesPerScene
    expect(scenes.length).toBeGreaterThan(1);
  });

  test('assigns unique scene IDs', () => {
    const script = `INT. ROOM A - DAY
Something happens.

EXT. ROOM B - DAY
Something else happens.

INT. ROOM C - NIGHT
The end.`;

    const scenes = fastSceneSplit(script);
    const ids = new Set(scenes.map((s) => s.sceneId));
    expect(ids.size).toBe(scenes.length);
  });
});
