import { getChannelHistoryFn } from '@/functions/realtime-history';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useReducer } from 'react';
import { useRealtime } from './client';
import {
  createInitialState,
  generationStreamReducer,
  type GenerationPhaseConfig,
  type GenerationStreamAction,
} from './generation-stream.reducer';
import { updateQueryCacheFromEvent } from './query-cache-updater';

type GenerationEvent = {
  event: string;
  data: Record<string, unknown>;
};

// Type guard helpers for extracting typed values from event data
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asNumber(value: unknown): number {
  return typeof value === 'number' ? value : 0;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

type FrameStatus = 'pending' | 'generating' | 'completed' | 'failed';

function asFrameStatus(value: unknown): FrameStatus | undefined {
  if (
    value === 'pending' ||
    value === 'generating' ||
    value === 'completed' ||
    value === 'failed'
  ) {
    return value;
  }
  return undefined;
}

/**
 * Maps a realtime event to a typed reducer action.
 * Uses type guards for runtime type safety.
 */
function mapEventToAction(
  eventName: string,
  data: Record<string, unknown>
): GenerationStreamAction | null {
  switch (eventName) {
    case 'generation.phase:start':
      return {
        type: 'PHASE_START',
        payload: {
          phase: asNumber(data.phase),
          phaseName: asString(data.phaseName),
        },
      };

    case 'generation.phase:complete':
      return {
        type: 'PHASE_COMPLETE',
        payload: { phase: asNumber(data.phase) },
      };

    case 'generation.scene:new':
      return {
        type: 'SCENE_NEW',
        payload: {
          sceneId: asString(data.sceneId),
          sceneNumber: asNumber(data.sceneNumber),
          title: asString(data.title),
          scriptExtract: asString(data.scriptExtract),
          durationSeconds: asNumber(data.durationSeconds),
        },
      };

    case 'generation.scene:updated':
      return {
        type: 'SCENE_UPDATED',
        payload: {
          sceneId: asString(data.sceneId),
          sceneNumber: asNumber(data.sceneNumber),
          title: asString(data.title),
          scriptExtract: asString(data.scriptExtract),
          durationSeconds: asNumber(data.durationSeconds),
        },
      };

    case 'generation.frame:created':
      return {
        type: 'FRAME_CREATED',
        payload: {
          frameId: asString(data.frameId),
          sceneId: asString(data.sceneId),
          orderIndex: asNumber(data.orderIndex),
        },
      };

    case 'generation.image:progress':
      return {
        type: 'IMAGE_PROGRESS',
        payload: {
          frameId: asString(data.frameId),
          status: asFrameStatus(data.status),
          thumbnailUrl: asOptionalString(data.thumbnailUrl),
          previewThumbnailUrl: asOptionalString(data.previewThumbnailUrl),
        },
      };

    case 'generation.video:progress':
      return {
        type: 'VIDEO_PROGRESS',
        payload: {
          frameId: asString(data.frameId),
          status: asFrameStatus(data.status),
          videoUrl: asOptionalString(data.videoUrl),
        },
      };

    case 'generation.complete':
      return {
        type: 'COMPLETE',
        payload: { sequenceId: asString(data.sequenceId) },
      };

    case 'generation.failed':
      return {
        type: 'FAILED',
        payload: { message: asString(data.message) },
      };

    case 'generation.error':
      return {
        type: 'ERROR',
        payload: {
          message: asString(data.message),
          phase: asOptionalNumber(data.phase),
        },
      };

    case 'generation.talent:matched':
      // Trust that the realtime schema enforces proper structure
      return {
        type: 'TALENT_MATCHED',
        payload: {
          matches: (Array.isArray(data.matches) ? data.matches : []).map(
            (m: Record<string, unknown>) => ({
              characterId: asString(m.characterId),
              characterName: asString(m.characterName),
              talentId: asString(m.talentId),
              talentName: asString(m.talentName),
            })
          ),
        },
      };

    case 'generation.talent:unmatched':
      return {
        type: 'TALENT_UNMATCHED',
        payload: {
          unusedTalentIds: Array.isArray(data.unusedTalentIds)
            ? data.unusedTalentIds.map(asString)
            : [],
          unusedTalentNames: Array.isArray(data.unusedTalentNames)
            ? data.unusedTalentNames.map(asString)
            : [],
        },
      };

    case 'generation.location:matched':
      return {
        type: 'LOCATION_MATCHED',
        payload: {
          matches: (Array.isArray(data.matches) ? data.matches : []).map(
            (m: Record<string, unknown>) => ({
              locationId: asString(m.locationId),
              libraryLocationId: asString(m.libraryLocationId),
              libraryLocationName: asString(m.libraryLocationName),
              referenceImageUrl: asString(m.referenceImageUrl),
              description: asOptionalString(m.description),
            })
          ),
        },
      };

    case 'generation.preview:replaced':
      return {
        type: 'PREVIEW_REPLACED',
        payload: { newSceneCount: asNumber(data.newSceneCount) },
      };

    default:
      return null;
  }
}

/**
 * Hook for subscribing to real-time generation events for a sequence.
 *
 * @param sequenceId - The sequence ID to subscribe to
 * @param enabled - Whether to enable the subscription (default: true)
 * @returns Generation stream state with scenes, frames, and phase progress
 *
 * @example
 * ```tsx
 * const { state, status, reset } = useGenerationStream(sequenceId, {
 *   enabled: sequence.status === 'processing',
 * });
 *
 * // Show progress indicator
 * <PhaseIndicator phases={state.phases} currentPhase={state.currentPhase} />
 *
 * // Show streaming scenes
 * {state.scenes.map((scene) => (
 *   <SceneCard key={scene.sceneId} scene={scene} />
 * ))}
 * ```
 */
export function useGenerationStream(
  sequenceId: string,
  phaseConfig?: GenerationPhaseConfig
) {
  const queryClient = useQueryClient();
  const [state, dispatch] = useReducer(
    generationStreamReducer,
    phaseConfig,
    createInitialState
  );

  // Handle incoming events
  const handleEvent = useCallback(
    (event: GenerationEvent) => {
      const { event: eventName, data } = event;

      // Update TanStack Query cache for data-related events
      updateQueryCacheFromEvent(queryClient, sequenceId, eventName, data);

      // Map event to typed action and dispatch
      const action = mapEventToAction(eventName, data);
      if (action) {
        dispatch(action);
      }
    },
    [queryClient, sequenceId]
  );

  // Replay channel history on mount so progress survives page refresh.
  // The realtime client doesn't replay past events on reconnect, so we fetch
  // all events from server-side history and replay them through the reducer.
  useEffect(() => {
    getChannelHistoryFn({ data: { channel: sequenceId } })
      .then((events: { event: string; data: string }[]) => {
        for (const evt of events) {
          try {
            const parsed = JSON.parse(evt.data);
            const action = mapEventToAction(evt.event, parsed);
            if (action) dispatch(action);
          } catch (e) {
            console.error(
              `[useGenerationStream] Failed to parse history event "${evt.event}":`,
              e
            );
          }
        }
      })
      .catch((error: Error) => {
        console.error(
          `[useGenerationStream] Failed to fetch history for "${sequenceId}":`,
          error
        );
      });
  }, [sequenceId]);

  // Subscribe to realtime events for live updates.
  const { status } = useRealtime({
    channels: [sequenceId],
    events: [
      'generation.phase:start',
      'generation.phase:complete',
      'generation.scene:new',
      'generation.scene:updated',
      'generation.frame:created',
      'generation.frame:updated',
      'generation.image:progress',
      'generation.video:progress',
      'generation.audio:progress',
      'generation.variant-image:progress',
      'generation.talent:matched',
      'generation.talent:unmatched',
      'generation.location:matched',
      'generation.poster:ready',
      'generation.preview:replaced',
      'generation.complete',
      'generation.failed',
      'generation.updated',
      'generation.error',
    ] as const,
    onData: handleEvent,
    enabled: true,
  });

  const reset = useCallback(() => {
    dispatch({ type: 'RESET' });
  }, []);

  return {
    state,
    status,
    reset,
  };
}
