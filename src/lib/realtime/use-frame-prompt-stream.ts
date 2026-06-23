import { getChannelHistoryFn } from '@/functions/realtime-history';
import { useCallback, useEffect, useReducer } from 'react';
import { z } from 'zod';
import { useRealtime } from './client';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'realtime', 'use-frame-prompt-stream']);

export type FramePromptKind = 'visual' | 'motion';

const historyPayloadSchema = z.object({
  promptType: z.enum(['visual', 'motion']),
  delta: z.string().optional(),
  error: z.string().optional(),
});

type FramePromptStreamStatus =
  | 'idle'
  | 'pending'
  | 'streaming'
  | 'completed'
  | 'failed';

type PerPromptState = {
  text: string;
  status: FramePromptStreamStatus;
  error?: string;
};

type FramePromptStreamState = {
  visual: PerPromptState;
  motion: PerPromptState;
};

const initialPerPrompt: PerPromptState = { text: '', status: 'idle' };

const initialState: FramePromptStreamState = {
  visual: initialPerPrompt,
  motion: initialPerPrompt,
};

type Action =
  | { type: 'PENDING'; promptType: FramePromptKind }
  | { type: 'DELTA'; promptType: FramePromptKind; delta: string }
  | { type: 'COMPLETED'; promptType: FramePromptKind }
  | { type: 'FAILED'; promptType: FramePromptKind; error: string }
  | { type: 'RESET' };

/**
 * A delta arriving after a terminal state (`completed` / `failed`) means a
 * fresh regeneration just started — reset the accumulated text so the
 * textarea doesn't carry over the previous run's prompt.
 */
function reducePromptState(
  state: PerPromptState,
  action: Extract<Action, { promptType: FramePromptKind }>
): PerPromptState {
  switch (action.type) {
    case 'PENDING':
      // Caller-driven: the mutation enqueued a workflow and we're waiting for
      // the first realtime delta. Clears any prior run's text so the textarea
      // doesn't display the previous prompt during the gap.
      return { text: '', status: 'pending', error: undefined };
    case 'DELTA':
      if (state.status === 'streaming') {
        return { ...state, text: state.text + action.delta };
      }
      return { text: action.delta, status: 'streaming', error: undefined };
    case 'COMPLETED':
      return { ...state, status: 'completed', error: undefined };
    case 'FAILED':
      return { ...state, status: 'failed', error: action.error };
  }
}

function reducer(
  state: FramePromptStreamState,
  action: Action
): FramePromptStreamState {
  if (action.type === 'RESET') return initialState;
  return {
    ...state,
    [action.promptType]: reducePromptState(state[action.promptType], action),
  };
}

/**
 * Subscribe to a frame's per-frame prompt-regen realtime channel and surface
 * the live-streaming text plus terminal status for each prompt type.
 *
 * The hook is gated on `enabled` so we only pay realtime + history-fetch
 * costs while the frame is actually being viewed — unsubscribe on nav-away.
 * On re-mount, channel history replays via `getChannelHistoryFn`, rebuilding
 * the streaming text (or terminal state) as if the user had been on the
 * frame the whole time.
 */
export function useFramePromptStream(
  shotId: string | undefined,
  enabled: boolean = true
) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const channelId = shotId ? `frame-prompt:${shotId}` : undefined;
  const active = enabled && Boolean(channelId);

  // Replay history on mount so a user who navigates back mid-regen sees the
  // accumulated text and the right status. Re-keys on shotId so switching
  // frames clears and re-fetches.
  useEffect(() => {
    if (!active || !channelId) {
      dispatch({ type: 'RESET' });
      return;
    }
    dispatch({ type: 'RESET' });
    let cancelled = false;
    getChannelHistoryFn({ data: { channel: channelId } })
      .then((events: { event: string; data: string }[]) => {
        if (cancelled) return;
        for (const evt of events) {
          const result = historyPayloadSchema.safeParse(JSON.parse(evt.data));
          if (!result.success) {
            logger.error(`Invalid history event "${evt.event}":`, {
              data: result.error,
            });
            continue;
          }
          const parsed = result.data;
          if (
            evt.event === 'framePrompt.streaming' &&
            typeof parsed.delta === 'string'
          ) {
            dispatch({
              type: 'DELTA',
              promptType: parsed.promptType,
              delta: parsed.delta,
            });
          } else if (evt.event === 'framePrompt.completed') {
            dispatch({ type: 'COMPLETED', promptType: parsed.promptType });
          } else if (
            evt.event === 'framePrompt.failed' &&
            typeof parsed.error === 'string'
          ) {
            dispatch({
              type: 'FAILED',
              promptType: parsed.promptType,
              error: parsed.error,
            });
          }
        }
      })
      .catch((error: Error) => {
        logger.error(`Failed to fetch history for "${channelId}":`, {
          err: error,
        });
      });
    return () => {
      cancelled = true;
    };
  }, [active, channelId]);

  const handleEvent = useCallback(
    (msg: {
      event: string;
      data: { promptType?: FramePromptKind; delta?: string; error?: string };
    }) => {
      const { event, data } = msg;
      if (!data.promptType) return;
      if (event === 'framePrompt.streaming' && typeof data.delta === 'string') {
        dispatch({
          type: 'DELTA',
          promptType: data.promptType,
          delta: data.delta,
        });
      } else if (event === 'framePrompt.completed') {
        dispatch({ type: 'COMPLETED', promptType: data.promptType });
      } else if (
        event === 'framePrompt.failed' &&
        typeof data.error === 'string'
      ) {
        dispatch({
          type: 'FAILED',
          promptType: data.promptType,
          error: data.error,
        });
      }
    },
    []
  );

  useRealtime({
    channels: channelId ? [channelId] : [],
    events: [
      'framePrompt.streaming',
      'framePrompt.completed',
      'framePrompt.failed',
    ] as const,
    onData: handleEvent,
    enabled: active,
  });

  const reset = useCallback(() => dispatch({ type: 'RESET' }), []);
  const markPending = useCallback(
    (promptType: FramePromptKind) => dispatch({ type: 'PENDING', promptType }),
    []
  );

  return { state, reset, markPending };
}
