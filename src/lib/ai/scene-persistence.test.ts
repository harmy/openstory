import { describe, expect, it } from 'vitest';
import type { Scene } from './scene-analysis.schema';
import { buildSceneInserts } from './scene-persistence';

function makeScene(overrides: Partial<Scene> = {}): Scene {
  return {
    sceneId: 'analysis-scene-1',
    sceneNumber: 1,
    originalScript: { extract: 'A man walks in.', dialogue: [] },
    metadata: {
      title: 'Entrance',
      durationSeconds: 4,
      location: 'INT. OFFICE - DAY',
      timeOfDay: 'day',
      storyBeat: 'introduction',
    },
    continuity: {
      characterTags: ['man'],
      environmentTag: 'office',
      elementTags: [],
      colorPalette: 'warm',
      lightingSetup: 'soft daylight',
      styleTag: 'cinematic',
    },
    ...overrides,
  };
}

describe('buildSceneInserts', () => {
  it('maps scene-level fields onto scene rows with 0-based orderIndex', () => {
    const rows = buildSceneInserts('seq-1', [
      makeScene(),
      makeScene({ sceneId: 'analysis-scene-2', sceneNumber: 2 }),
    ]);

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      sequenceId: 'seq-1',
      orderIndex: 0,
      location: 'INT. OFFICE - DAY',
      timeOfDay: 'day',
      storyBeat: 'introduction',
      title: 'Entrance',
    });
    expect(rows[1]?.orderIndex).toBe(1);
  });

  it('carries continuity and original script onto the scene row', () => {
    const [row] = buildSceneInserts('seq-1', [makeScene()]);
    expect(row?.continuity?.environmentTag).toBe('office');
    expect(row?.originalScript?.extract).toBe('A man walks in.');
  });

  it('defaults missing scene metadata to null (no analysis metadata yet)', () => {
    const [row] = buildSceneInserts('seq-1', [
      makeScene({ metadata: undefined, continuity: undefined }),
    ]);
    expect(row?.location).toBeNull();
    expect(row?.timeOfDay).toBeNull();
    expect(row?.storyBeat).toBeNull();
    expect(row?.title).toBeNull();
    expect(row?.continuity).toBeNull();
  });

  it('returns an empty array for no scenes', () => {
    expect(buildSceneInserts('seq-1', [])).toEqual([]);
  });
});
