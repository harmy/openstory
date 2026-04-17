import { describe, expect, test } from 'bun:test';
import {
  createStreamingSceneParser,
  stripCodeFences,
} from './streaming-scene-parser';

const makeScene = (n: number) => ({
  sceneId: `scene-${n}`,
  sceneNumber: n,
  originalScript: { extract: `Scene ${n} action`, dialogue: [] },
  metadata: {
    title: `Scene ${n} Title`,
    durationSeconds: 5,
    location: 'INT. OFFICE',
    timeOfDay: 'day',
    storyBeat: 'exposition',
  },
});

const fullResponse = {
  status: 'success',
  projectMetadata: {
    title: 'Test Movie',
    aspectRatio: '16:9',
    generatedAt: '',
  },
  scenes: [makeScene(1), makeScene(2), makeScene(3)],
};

describe('createStreamingSceneParser', () => {
  test('emits title when projectMetadata.title appears', () => {
    const parser = createStreamingSceneParser();

    // Partial JSON with title but no scenes yet
    const partial =
      '{"status":"success","projectMetadata":{"title":"Test Movie"';
    const events = parser.feed(partial);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'title', title: 'Test Movie' });
  });

  test('does not emit title twice', () => {
    const parser = createStreamingSceneParser();

    const partial1 = '{"projectMetadata":{"title":"Test Movie"';
    parser.feed(partial1);

    const partial2 =
      '{"projectMetadata":{"title":"Test Movie","aspectRatio":"16:9"}';
    const events = parser.feed(partial2);

    expect(events).toHaveLength(0);
  });

  test('emits scenes as they become complete', () => {
    const parser = createStreamingSceneParser();

    const oneScene = JSON.stringify({
      projectMetadata: fullResponse.projectMetadata,
      scenes: [makeScene(1)],
    });

    const events = parser.feed(oneScene);
    // Title + 1 scene
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: 'title', title: 'Test Movie' });
    expect(events[1]).toMatchObject({ type: 'scene', index: 0 });
    expect(events[1].type === 'scene' && events[1].scene.sceneId).toBe(
      'scene-1'
    );
  });

  test('emits new scenes incrementally', () => {
    const parser = createStreamingSceneParser();

    // Feed with 1 scene
    const oneScene = JSON.stringify({
      projectMetadata: fullResponse.projectMetadata,
      scenes: [makeScene(1)],
    });
    const events1 = parser.feed(oneScene);
    expect(events1).toHaveLength(2); // title + scene

    // Feed with 2 scenes — should only emit the new one
    const twoScenes = JSON.stringify({
      projectMetadata: fullResponse.projectMetadata,
      scenes: [makeScene(1), makeScene(2)],
    });
    const events2 = parser.feed(twoScenes);
    expect(events2).toHaveLength(1);
    expect(events2[0]).toMatchObject({ type: 'scene', index: 1 });
  });

  test('does not emit incomplete scenes', () => {
    const parser = createStreamingSceneParser();

    // Scene missing metadata (required field)
    const partial = JSON.stringify({
      projectMetadata: fullResponse.projectMetadata,
      scenes: [{ sceneId: 'scene-1', sceneNumber: 1 }],
    });

    const events = parser.feed(partial);
    // Title emitted, but scene is incomplete (missing originalScript/metadata)
    // Actually metadata is optional in sceneSchema but required in sceneSplittingResultSchema
    // The parser uses its own schema that requires metadata
    const sceneEvents = events.filter((e) => e.type === 'scene');
    expect(sceneEvents).toHaveLength(0);
  });

  test('handles invalid JSON gracefully', () => {
    const parser = createStreamingSceneParser();
    const events = parser.feed('{invalid json');
    expect(events).toHaveLength(0);
  });

  test('handles empty input', () => {
    const parser = createStreamingSceneParser();
    const events = parser.feed('');
    expect(events).toHaveLength(0);
  });

  test('stops at first incomplete scene', () => {
    const parser = createStreamingSceneParser();

    // Scene 1 complete, scene 2 incomplete (missing metadata)
    const partial = JSON.stringify({
      projectMetadata: fullResponse.projectMetadata,
      scenes: [makeScene(1), { sceneId: 'scene-2', sceneNumber: 2 }],
    });

    const events = parser.feed(partial);
    const sceneEvents = events.filter((e) => e.type === 'scene');
    expect(sceneEvents).toHaveLength(1);
    expect(sceneEvents[0].scene.sceneId).toBe('scene-1');
  });

  test('reset clears state', () => {
    const parser = createStreamingSceneParser();

    const oneScene = JSON.stringify({
      projectMetadata: fullResponse.projectMetadata,
      scenes: [makeScene(1)],
    });
    parser.feed(oneScene);
    parser.reset();

    // After reset, should re-emit title and scene
    const events = parser.feed(oneScene);
    expect(events).toHaveLength(2);
  });

  test('handles full response in one feed', () => {
    const parser = createStreamingSceneParser();
    const events = parser.feed(JSON.stringify(fullResponse));

    expect(events).toHaveLength(4); // title + 3 scenes
    expect(events[0]).toEqual({ type: 'title', title: 'Test Movie' });
    expect(events[1]).toMatchObject({ type: 'scene', index: 0 });
    expect(events[2]).toMatchObject({ type: 'scene', index: 1 });
    expect(events[3]).toMatchObject({ type: 'scene', index: 2 });
  });

  test('handles markdown code fences around JSON', () => {
    const parser = createStreamingSceneParser();
    const fenced = '```json\n' + JSON.stringify(fullResponse) + '\n```';
    const events = parser.feed(fenced);

    expect(events).toHaveLength(4);
    expect(events[0]).toEqual({ type: 'title', title: 'Test Movie' });
  });

  test('emits scene:updated when title changes on subsequent feeds', () => {
    const parser = createStreamingSceneParser();

    // Feed scene with truncated title (simulates partial-json completing a partial string)
    const truncatedScene = {
      ...makeScene(1),
      metadata: { ...makeScene(1).metadata, title: 'City' },
    };
    const partial1 = JSON.stringify({
      projectMetadata: fullResponse.projectMetadata,
      scenes: [truncatedScene],
    });
    const events1 = parser.feed(partial1);
    expect(events1.filter((e) => e.type === 'scene')).toHaveLength(1);

    // Feed same scene with full title
    const fullScene = {
      ...makeScene(1),
      metadata: { ...makeScene(1).metadata, title: 'City Skyline at Dawn' },
    };
    const partial2 = JSON.stringify({
      projectMetadata: fullResponse.projectMetadata,
      scenes: [fullScene],
    });
    const events2 = parser.feed(partial2);
    const updateEvents = events2.filter((e) => e.type === 'scene:updated');
    expect(updateEvents).toHaveLength(1);
    expect(updateEvents[0].scene.metadata.title).toBe('City Skyline at Dawn');
    expect(updateEvents[0].index).toBe(0);
  });

  test('does not emit scene:updated when title is unchanged', () => {
    const parser = createStreamingSceneParser();

    const data = JSON.stringify({
      projectMetadata: fullResponse.projectMetadata,
      scenes: [makeScene(1)],
    });

    parser.feed(data);
    const events2 = parser.feed(data);
    // No update events since title hasn't changed
    expect(events2.filter((e) => e.type === 'scene:updated')).toHaveLength(0);
  });

  test('handles partial JSON inside code fences', () => {
    const parser = createStreamingSceneParser();
    const partial =
      '```json\n{"projectMetadata":{"title":"Fenced Title"},"scenes":[';
    const events = parser.feed(partial);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: 'title', title: 'Fenced Title' });
  });
});

describe('stripCodeFences', () => {
  test('strips ```json prefix and ``` suffix', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test('strips ``` without language tag', () => {
    expect(stripCodeFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  test('leaves plain JSON unchanged', () => {
    expect(stripCodeFences('{"a":1}')).toBe('{"a":1}');
  });

  test('handles partial fenced input (no closing)', () => {
    expect(stripCodeFences('```json\n{"a":1')).toBe('{"a":1');
  });
});
