import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  generationStreamReducer,
  type GenerationStreamAction,
  type GenerationStreamState,
} from './generation-stream.reducer';

const FRAME_ID = 'frame-1';

function apply(
  state: GenerationStreamState,
  ...actions: GenerationStreamAction[]
): GenerationStreamState {
  return actions.reduce(generationStreamReducer, state);
}

function withCreatedFrame(): GenerationStreamState {
  return apply(createInitialState(), {
    type: 'FRAME_CREATED',
    payload: { shotId: FRAME_ID, sceneId: 'scene-1', orderIndex: 0 },
  });
}

describe('generationStreamReducer — frame retry tracking (#882)', () => {
  it('records image retry state from an IMAGE_PROGRESS retry signal', () => {
    const state = apply(withCreatedFrame(), {
      type: 'IMAGE_PROGRESS',
      payload: {
        shotId: FRAME_ID,
        status: 'generating',
        retry: { attempt: 2, maxAttempts: 3 },
      },
    });

    expect(state.frameRetries.get(FRAME_ID)).toEqual({
      image: { attempt: 2, maxAttempts: 3 },
    });
  });

  it('tracks retry even without a preceding FRAME_CREATED (regenerating an existing frame)', () => {
    const state = apply(createInitialState(), {
      type: 'IMAGE_PROGRESS',
      payload: {
        shotId: FRAME_ID,
        status: 'generating',
        retry: { attempt: 2, maxAttempts: 3 },
      },
    });

    // Shot isn't in the frames map, but its retry state is still surfaced.
    expect(state.frames.has(FRAME_ID)).toBe(false);
    expect(state.frameRetries.get(FRAME_ID)).toEqual({
      image: { attempt: 2, maxAttempts: 3 },
    });
  });

  it('clears image retry state on a terminal IMAGE_PROGRESS', () => {
    const state = apply(
      withCreatedFrame(),
      {
        type: 'IMAGE_PROGRESS',
        payload: {
          shotId: FRAME_ID,
          status: 'generating',
          retry: { attempt: 2, maxAttempts: 3 },
        },
      },
      {
        type: 'IMAGE_PROGRESS',
        payload: {
          shotId: FRAME_ID,
          status: 'completed',
          thumbnailUrl: 'https://example.com/i.jpg',
        },
      }
    );

    expect(state.frameRetries.has(FRAME_ID)).toBe(false);
    expect(state.frames.get(FRAME_ID)?.imageStatus).toBe('completed');
  });

  it('keeps image and video retry state independent', () => {
    const state = apply(
      withCreatedFrame(),
      {
        type: 'IMAGE_PROGRESS',
        payload: {
          shotId: FRAME_ID,
          status: 'generating',
          retry: { attempt: 2, maxAttempts: 3 },
        },
      },
      {
        type: 'VIDEO_PROGRESS',
        payload: {
          shotId: FRAME_ID,
          status: 'generating',
          retry: { attempt: 3, maxAttempts: 3 },
        },
      }
    );

    expect(state.frameRetries.get(FRAME_ID)).toEqual({
      image: { attempt: 2, maxAttempts: 3 },
      video: { attempt: 3, maxAttempts: 3 },
    });

    // Clearing the video retry leaves the image retry intact.
    const next = apply(state, {
      type: 'VIDEO_PROGRESS',
      payload: { shotId: FRAME_ID, status: 'completed' },
    });
    expect(next.frameRetries.get(FRAME_ID)).toEqual({
      image: { attempt: 2, maxAttempts: 3 },
    });
  });

  it('no-ops (returns same state) on a non-retry update with no prior retry', () => {
    const base = withCreatedFrame();
    const next = apply(base, {
      type: 'IMAGE_PROGRESS',
      payload: { shotId: FRAME_ID, status: 'generating' },
    });
    // frames map updates, but frameRetries reference is unchanged.
    expect(next.frameRetries).toBe(base.frameRetries);
  });

  it('records a retry with no maxAttempts (image side leans on CF default budget)', () => {
    const state = apply(withCreatedFrame(), {
      type: 'IMAGE_PROGRESS',
      payload: {
        shotId: FRAME_ID,
        status: 'generating',
        retry: { attempt: 2 },
      },
    });

    expect(state.frameRetries.get(FRAME_ID)).toEqual({
      image: { attempt: 2 },
    });
  });

  it('clears all retry state on PREVIEW_REPLACED', () => {
    const state = apply(withCreatedFrame(), {
      type: 'IMAGE_PROGRESS',
      payload: {
        shotId: FRAME_ID,
        status: 'generating',
        retry: { attempt: 2, maxAttempts: 3 },
      },
    });
    expect(state.frameRetries.size).toBe(1);

    const cleared = apply(state, {
      type: 'PREVIEW_REPLACED',
      payload: { newSceneCount: 4 },
    });
    expect(cleared.frameRetries.size).toBe(0);
  });
});
