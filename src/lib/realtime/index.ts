import { getRedis } from '#redis';
import { Realtime } from '@upstash/realtime';
import { z } from 'zod';

/**
 * Realtime event schema for generation progress streaming.
 *
 * Events are organized by category:
 * - generation.* - Events for the overall generation process
 */
export const realtimeSchema = {
  // Talent library events
  talent: {
    // Sheet generation progress
    'sheet:progress': z.object({
      talentId: z.string(),
      status: z.enum(['generating', 'completed', 'failed']),
      sheetId: z.string().optional(),
      sheetImageUrl: z.string().optional(),
      headshotImageUrl: z.string().optional(),
      error: z.string().optional(),
    }),
  },

  generation: {
    // Phase lifecycle events
    'phase:start': z.object({
      phase: z.number(),
      phaseName: z.string(),
    }),
    'phase:complete': z.object({
      phase: z.number(),
    }),

    // Scene events (progressive display during analysis)
    'scene:new': z.object({
      sceneId: z.string(),
      sceneNumber: z.number(),
      title: z.string(),
      scriptExtract: z.string(),
      durationSeconds: z.number(),
    }),

    // Scene updated (progressive title correction during streaming)
    'scene:updated': z.object({
      sceneId: z.string(),
      sceneNumber: z.number(),
      title: z.string(),
      scriptExtract: z.string(),
      durationSeconds: z.number(),
    }),

    // Frame events (after DB write)
    'frame:created': z.object({
      frameId: z.string(),
      sceneId: z.string(),
      orderIndex: z.number(),
    }),

    // Frame updated with prompts (visual, motion, audio)
    'frame:updated': z.object({
      frameId: z.string(),
      updateType: z.enum([
        'visual-prompt',
        'motion-prompt',
        'audio-design',
        'music-design',
      ]),
      metadata: z.unknown(), // Full Scene object with prompts
    }),

    // Image generation progress
    'image:progress': z.object({
      frameId: z.string(),
      status: z
        .enum(['pending', 'generating', 'completed', 'failed'])
        .optional(),
      thumbnailUrl: z.string().optional(),
      previewThumbnailUrl: z.string().optional(),
      model: z.string().optional(),
    }),

    // Fast preview frames replaced by AI-analyzed frames
    'preview:replaced': z.object({
      newSceneCount: z.number(),
    }),

    // Image generation progress
    'variant-image:progress': z.object({
      frameId: z.string(),
      status: z.enum(['pending', 'generating', 'completed', 'failed']),
      variantImageUrl: z.string().optional(),
    }),

    // Video generation progress
    'video:progress': z.object({
      frameId: z.string(),
      status: z.enum(['pending', 'generating', 'completed', 'failed']),
      videoUrl: z.string().optional(),
    }),

    // Audio/music generation progress (frameId optional for sequence-level music)
    'audio:progress': z.object({
      frameId: z.string().optional(),
      status: z.enum(['pending', 'generating', 'completed', 'failed']),
      audioUrl: z.string().optional(),
    }),

    // Merge progress (video stitching + audio-video muxing)
    'merge:progress': z.object({
      step: z.enum(['video', 'audio-video']),
      status: z.enum(['merging', 'completed', 'failed']),
      mergedVideoUrl: z.string().optional(),
    }),

    // Character sheet generation progress (during recasting)
    'character-sheet:progress': z.object({
      characterId: z.string(),
      status: z.enum(['generating', 'completed', 'failed']),
      sheetImageUrl: z.string().optional(),
      error: z.string().optional(),
    }),

    // Location reference generation progress (during recasting)
    'location-sheet:progress': z.object({
      locationId: z.string(),
      status: z.enum(['generating', 'completed', 'failed']),
      referenceImageUrl: z.string().optional(),
      error: z.string().optional(),
    }),

    // Recast-triggered frame regeneration events (characters)
    'recast:start': z.object({
      characterId: z.string(),
      frameCount: z.number(),
    }),
    'recast:complete': z.object({
      characterId: z.string(),
      successCount: z.number(),
      failedCount: z.number(),
    }),
    'recast:failed': z.object({
      characterId: z.string(),
      error: z.string(),
    }),

    // Recast-location events
    'recast-location:start': z.object({
      locationId: z.string(),
      frameCount: z.number(),
    }),
    'recast-location:complete': z.object({
      locationId: z.string(),
      successCount: z.number(),
      failedCount: z.number(),
    }),
    'recast-location:failed': z.object({
      locationId: z.string(),
      error: z.string(),
    }),

    // Location matching events
    'location:matched': z.object({
      matches: z.array(
        z.object({
          locationId: z.string(),
          libraryLocationId: z.string(),
          libraryLocationName: z.string(),
          referenceImageUrl: z.string(),
          description: z.string().optional(),
        })
      ),
    }),

    // Talent matching events (during sequence generation)
    'talent:matched': z.object({
      matches: z.array(
        z.object({
          characterId: z.string(),
          characterName: z.string(),
          talentId: z.string(),
          talentName: z.string(),
        })
      ),
    }),
    'talent:unmatched': z.object({
      unusedTalentIds: z.array(z.string()),
      unusedTalentNames: z.array(z.string()),
    }),

    // Poster image ready (sequence-level preview from script)
    'poster:ready': z.object({
      posterUrl: z.string(),
    }),

    // Sequence events
    updated: z.object({
      title: z.string().optional(),
    }),
    failed: z.object({
      message: z.string(),
    }),
    // Terminal events
    complete: z.object({
      sequenceId: z.string(),
    }),
    error: z.object({
      message: z.string(),
      phase: z.number().optional(),
    }),
  },
};

let realtimeInstance: ReturnType<typeof createRealtime> | null = null;

function createRealtime() {
  const redis = getRedis();
  return new Realtime({
    schema: realtimeSchema,
    redis,
    history: {
      expireAfterSecs: 60 * 60 * 24 * 30, // 30 days
    },
  });
}

/**
 * Get the Realtime instance for emitting/subscribing to events.
 * Lazily initialized to avoid errors when Redis env vars are not set.
 */
export function getRealtime() {
  if (realtimeInstance) return realtimeInstance;
  realtimeInstance = createRealtime();
  return realtimeInstance;
}

/**
 * Get a channel for a specific sequence to emit/receive events.
 * @param sequenceId - The sequence ID to use as the channel identifier
 */
export function getGenerationChannel(sequenceId?: string) {
  return sequenceId
    ? getRealtime().channel(sequenceId)
    : {
        emit: () => null,
      };
}

/**
 * Get a channel for talent library events.
 * @param talentId - The talent ID to use as the channel identifier
 */
export function getTalentChannel(talentId?: string) {
  return talentId
    ? getRealtime().channel(`talent:${talentId}`)
    : {
        emit: () => null,
      };
}
