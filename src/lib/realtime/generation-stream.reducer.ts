/**
 * Reducer for managing real-time generation stream state.
 * Handles events from the Upstash Realtime channel during storyboard generation.
 */

type FrameStatus = 'pending' | 'generating' | 'completed' | 'failed';

type StreamingScene = {
  sceneId: string;
  sceneNumber: number;
  title: string;
  scriptExtract: string;
  durationSeconds: number;
};

type StreamingFrame = {
  frameId: string;
  sceneId: string;
  orderIndex: number;
  imageStatus: FrameStatus;
  videoStatus: FrameStatus;
  thumbnailUrl?: string;
  previewThumbnailUrl?: string;
  videoUrl?: string;
};

type TalentMatch = {
  characterId: string;
  characterName: string;
  talentId: string;
  talentName: string;
};

type LocationMatch = {
  locationId: string;
  libraryLocationId: string;
  libraryLocationName: string;
  referenceImageUrl: string;
  description?: string;
};

type UnusedTalent = {
  ids: string[];
  names: string[];
};

export type GenerationPhase = {
  phase: number;
  phaseName: string;
  shortName: string;
  status: 'pending' | 'active' | 'completed';
};

export type GenerationStreamState = {
  /** Current generation phase (1-5) */
  currentPhase: number;
  /** All phases with their status */
  phases: GenerationPhase[];
  /** Scenes received during streaming */
  scenes: StreamingScene[];
  /** Frames with their generation status */
  frames: Map<string, StreamingFrame>;
  /** Whether generation is complete */
  isComplete: boolean;
  /** Whether generation failed */
  isFailed: boolean;
  /** Error message if generation failed */
  error?: string;
  /** Talent matched to characters during generation */
  talentMatches: TalentMatch[];
  /** Location matched during generation */
  locationMatches: LocationMatch[];
  /** Talent that weren't matched to any character */
  unusedTalent: UnusedTalent | null;
};

export type GenerationStreamAction =
  | {
      type: 'PHASE_START';
      payload: { phase: number; phaseName: string };
    }
  | { type: 'PHASE_COMPLETE'; payload: { phase: number } }
  | { type: 'SCENE_NEW'; payload: StreamingScene }
  | { type: 'SCENE_UPDATED'; payload: StreamingScene }
  | {
      type: 'FRAME_CREATED';
      payload: { frameId: string; sceneId: string; orderIndex: number };
    }
  | {
      type: 'IMAGE_PROGRESS';
      payload: {
        frameId: string;
        status?: FrameStatus;
        thumbnailUrl?: string;
        previewThumbnailUrl?: string;
      };
    }
  | {
      type: 'VIDEO_PROGRESS';
      payload: { frameId: string; status?: FrameStatus; videoUrl?: string };
    }
  | { type: 'COMPLETE'; payload: { sequenceId: string } }
  | { type: 'FAILED'; payload: { message: string } }
  | { type: 'ERROR'; payload: { message: string; phase?: number } }
  | { type: 'TALENT_MATCHED'; payload: { matches: TalentMatch[] } }
  | {
      type: 'TALENT_UNMATCHED';
      payload: { unusedTalentIds: string[]; unusedTalentNames: string[] };
    }
  | { type: 'LOCATION_MATCHED'; payload: { matches: LocationMatch[] } }
  | { type: 'PREVIEW_REPLACED'; payload: { newSceneCount: number } }
  | { type: 'RESET' };

const PHASES = [
  { name: 'Analyzing script\u2026', shortName: 'Script' },
  { name: 'Casting characters & locations\u2026', shortName: 'Casting' },
  { name: 'Generating references & prompts\u2026', shortName: 'References' },
  { name: 'Generating images\u2026', shortName: 'Images' },
] as const;

export type GenerationPhaseConfig = {
  autoGenerateMotion: boolean;
  autoGenerateMusic: boolean;
};

function getPhase5Label(config: GenerationPhaseConfig): {
  name: string;
  shortName: string;
} {
  const { autoGenerateMotion, autoGenerateMusic } = config;
  if (autoGenerateMotion && autoGenerateMusic) {
    return {
      name: 'Generating motion & music\u2026',
      shortName: 'Music & Motion',
    };
  }
  if (autoGenerateMotion) {
    return { name: 'Generating motion\u2026', shortName: 'Motion' };
  }
  return { name: 'Generating music\u2026', shortName: 'Music' };
}

export function createInitialState(
  config?: GenerationPhaseConfig
): GenerationStreamState {
  const phases: GenerationPhase[] = PHASES.map((p, i) => ({
    phase: i + 1,
    phaseName: p.name,
    shortName: p.shortName,
    status: 'pending' as const,
  }));

  if (config && (config.autoGenerateMotion || config.autoGenerateMusic)) {
    const label = getPhase5Label(config);
    phases.push({
      phase: 5,
      phaseName: label.name,
      shortName: label.shortName,
      status: 'pending',
    });
  }

  return {
    currentPhase: 0,
    phases,
    scenes: [],
    frames: new Map(),
    isComplete: false,
    isFailed: false,
    talentMatches: [],
    locationMatches: [],
    unusedTalent: null,
  };
}

export const initialGenerationStreamState: GenerationStreamState =
  createInitialState();

export function generationStreamReducer(
  state: GenerationStreamState,
  action: GenerationStreamAction
): GenerationStreamState {
  switch (action.type) {
    case 'PHASE_START': {
      const { phase, phaseName } = action.payload;

      // Ignore backwards phase transitions (prevents flickering from out-of-order events)
      if (phase < state.currentPhase) {
        return state;
      }

      const phaseExists = state.phases.some((p) => p.phase === phase);
      const updatedPhases = state.phases.map((p) =>
        p.phase === phase
          ? { ...p, phaseName, status: 'active' as const }
          : p.phase < phase
            ? { ...p, status: 'completed' as const }
            : p
      );

      // Add phase dynamically if it wasn't in initial state
      // (e.g. phase 5 when settings loaded after reducer init due to hydration)
      if (!phaseExists) {
        updatedPhases.push({
          phase,
          phaseName,
          shortName: phaseName
            .replace(/Generating\s+/i, '')
            .replace(/\u2026$/, ''),
          status: 'active',
        });
      }

      return { ...state, currentPhase: phase, phases: updatedPhases };
    }

    case 'PHASE_COMPLETE': {
      const { phase } = action.payload;
      return {
        ...state,
        phases: state.phases.map((p) =>
          p.phase === phase ? { ...p, status: 'completed' } : p
        ),
      };
    }

    case 'SCENE_NEW': {
      // Check if scene already exists to avoid duplicates
      const exists = state.scenes.some(
        (s) => s.sceneId === action.payload.sceneId
      );
      if (exists) return state;

      return {
        ...state,
        scenes: [...state.scenes, action.payload],
      };
    }

    case 'SCENE_UPDATED': {
      const idx = state.scenes.findIndex(
        (s) => s.sceneId === action.payload.sceneId
      );
      if (idx === -1) return state;
      const updated = [...state.scenes];
      updated[idx] = action.payload;
      return { ...state, scenes: updated };
    }

    case 'FRAME_CREATED': {
      const { frameId, sceneId, orderIndex } = action.payload;
      const newFrames = new Map(state.frames);
      newFrames.set(frameId, {
        frameId,
        sceneId,
        orderIndex,
        imageStatus: 'pending',
        videoStatus: 'pending',
      });
      return {
        ...state,
        frames: newFrames,
      };
    }

    case 'IMAGE_PROGRESS': {
      const { frameId, status, thumbnailUrl, previewThumbnailUrl } =
        action.payload;
      const frame = state.frames.get(frameId);
      if (!frame) return state;

      const newFrames = new Map(state.frames);
      newFrames.set(frameId, {
        ...frame,
        imageStatus: status ?? frame.imageStatus,
        thumbnailUrl: thumbnailUrl ?? frame.thumbnailUrl,
        previewThumbnailUrl: previewThumbnailUrl ?? frame.previewThumbnailUrl,
      });
      return {
        ...state,
        frames: newFrames,
      };
    }

    case 'VIDEO_PROGRESS': {
      const { frameId, status, videoUrl } = action.payload;
      const frame = state.frames.get(frameId);
      if (!frame) return state;

      const newFrames = new Map(state.frames);
      newFrames.set(frameId, {
        ...frame,
        ...(status !== undefined && { videoStatus: status }),
        videoUrl: videoUrl ?? frame.videoUrl,
      });
      return {
        ...state,
        frames: newFrames,
      };
    }

    case 'COMPLETE':
      return {
        ...state,
        isComplete: true,
        currentPhase: state.phases.length + 1, // Beyond last phase so all marked complete
        phases: state.phases.map((p) => ({ ...p, status: 'completed' })),
      };

    case 'FAILED':
      return {
        ...state,
        isFailed: true,
        error: action.payload.message,
      };

    case 'ERROR':
      return {
        ...state,
        error: action.payload.message,
      };

    case 'TALENT_MATCHED':
      return {
        ...state,
        talentMatches: action.payload.matches,
      };

    case 'TALENT_UNMATCHED':
      return {
        ...state,
        unusedTalent: {
          ids: action.payload.unusedTalentIds,
          names: action.payload.unusedTalentNames,
        },
      };

    case 'LOCATION_MATCHED':
      return {
        ...state,
        locationMatches: action.payload.matches,
      };

    case 'PREVIEW_REPLACED':
      // Clear frame state when preview frames are replaced by AI-analyzed frames
      return {
        ...state,
        scenes: [],
        frames: new Map(),
      };

    case 'RESET':
      return initialGenerationStreamState;

    default:
      return state;
  }
}
