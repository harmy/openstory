import { z } from 'zod';

// ============================================================================
// Character Bible Schemas
// ============================================================================

export const characterBibleEntrySchema = z.object({
  characterId: z.string().meta({
    description:
      'Unique identifier for cross-referencing this character across scenes',
  }),
  name: z
    .string()
    .meta({ description: 'Full character name as written in the script' }),
  age: z.string().meta({
    description: 'Age as number (e.g., 35) or range (e.g., "30s", "early 40s")',
  }),
  gender: z
    .string()
    .catch('')
    .meta({ description: 'Character gender for casting consistency' }),
  ethnicity: z.string().catch('').meta({
    description: 'Character ethnicity for accurate visual representation',
  }),
  physicalDescription: z.string().catch('').meta({
    description:
      'Detailed appearance: height, build, hair color, eye color, distinguishing features',
  }),
  standardClothing: z.string().catch('').meta({
    description:
      'Default outfit and clothing style for visual consistency across scenes',
  }),
  distinguishingFeatures: z.string().catch('').meta({
    description:
      'Unique visual markers: scars, tattoos, accessories, distinctive mannerisms',
  }),
  consistencyTag: z.string().catch('').meta({
    description:
      'Short prompt tag for image generation (e.g., "detective_sarah_blonde_30s")',
  }),
});

// ============================================================================
// Element Bible Schemas (user-uploaded reference images)
// ============================================================================

export const elementBibleEntrySchema = z.object({
  token: z.string().meta({
    description:
      'Uppercase token used in the script to reference this element (e.g. "LOGO", "BOTTLE")',
  }),
  description: z.string().catch('').meta({
    description:
      'Concise visual description of the element for prompt guidance',
  }),
  consistencyTag: z.string().catch('').meta({
    description: 'Short slug tag for image generation (e.g. "red-hex-logo")',
  }),
  firstMention: z
    .object({
      sceneId: z.string().catch(''),
      text: z.string().catch(''),
      lineNumber: z.number().catch(0),
    })
    .catch({ sceneId: '', text: '', lineNumber: 0 })
    .meta({ description: 'First appearance of this element in the script' }),
});

// ============================================================================
// Location Bible Schemas
// ============================================================================

export const locationBibleEntrySchema = z.object({
  locationId: z.string().meta({
    description:
      'Unique identifier for cross-referencing this location across scenes',
  }),
  name: z.string().meta({
    description:
      'Location name as written in the script (e.g., "INT. OFFICE - DAY")',
  }),
  type: z.enum(['interior', 'exterior', 'both']).meta({
    description: 'Whether the location is interior, exterior, or both',
  }),
  timeOfDay: z.string().catch('').meta({
    description: 'Default time of day: day, night, dusk, dawn, etc.',
  }),
  description: z.string().catch('').meta({
    description:
      'Detailed visual description of the location including layout, size, and atmosphere',
  }),
  architecturalStyle: z.string().catch('').meta({
    description:
      'Architectural or design style (e.g., "modern minimalist", "industrial loft", "Victorian")',
  }),
  keyFeatures: z.string().catch('').meta({
    description:
      'Notable visual elements that define this location (e.g., "large windows, exposed brick, vintage furniture")',
  }),
  colorPalette: z.string().catch('').meta({
    description:
      'Dominant colors and color scheme (e.g., "cool blues, steel grays, warm wood accents")',
  }),
  lightingSetup: z.string().catch('').meta({
    description:
      'Primary lighting characteristics (e.g., "harsh overhead fluorescent", "warm golden hour sunlight")',
  }),
  ambiance: z.string().catch('').meta({
    description:
      'Mood and atmosphere of the location (e.g., "tense corporate", "cozy intimate", "gritty urban")',
  }),
  consistencyTag: z.string().catch('').meta({
    description:
      'Short prompt tag for image generation (e.g., "office_modern_steel_glass")',
  }),
  firstMention: z
    .object({
      sceneId: z
        .string()
        .catch('')
        .meta({ description: 'Scene ID where location first appears' }),
      text: z
        .string()
        .catch('')
        .meta({ description: 'Original script text mentioning the location' }),
      lineNumber: z
        .number()
        .catch(0)
        .meta({ description: 'Line number in script' }),
    })
    .catch({ sceneId: '', text: '', lineNumber: 0 })
    .meta({ description: 'First appearance of this location in the script' }),
});

// ============================================================================
// Project Metadata Schema
// ============================================================================

export const projectMetadataSchema = z.object({
  title: z
    .string()
    .catch('Untitled')
    .meta({ description: 'Project title extracted from the script' }),
  aspectRatio: z
    .string()
    .catch('16:9')
    .meta({ description: 'Video aspect ratio (e.g., "16:9", "9:16", "1:1")' }),
  generatedAt: z
    .string()
    .catch('')
    .meta({ description: 'ISO 8601 timestamp of generation' }),
});

// ============================================================================
// Variant Schemas (A/B/C Options)
// ============================================================================

export const cameraAngleVariantSchema = z.object({
  id: z
    .enum(['A1', 'A2', 'A3'])
    .catch('A1')
    .meta({ description: 'Camera angle option identifier (A1, A2, or A3)' }),
  description: z.string().catch('').meta({
    description:
      'Description of the camera angle (e.g., "wide establishing shot")',
  }),
  effect: z
    .string()
    .catch('')
    .meta({ description: 'Visual/emotional effect of this angle' }),
});

export const movementStyleVariantSchema = z.object({
  id: z
    .enum(['B1', 'B2', 'B3'])
    .catch('B1')
    .meta({ description: 'Movement style option identifier (B1, B2, or B3)' }),
  description: z.string().catch('').meta({
    description: 'Description of camera movement (e.g., "slow dolly forward")',
  }),
  energy: z
    .string()
    .transform((v) => v.toLowerCase())
    .pipe(z.enum(['low', 'medium', 'high']))
    .catch('medium')
    .meta({
      description: 'Energy level of the movement: low, medium, or high',
    }),
});

export const moodTreatmentVariantSchema = z.object({
  id: z
    .enum(['C1', 'C2', 'C3'])
    .catch('C1')
    .meta({ description: 'Mood treatment option identifier (C1, C2, or C3)' }),
  description: z
    .string()
    .catch('')
    .meta({ description: 'Description of the mood/atmosphere treatment' }),
  tone: z
    .string()
    .catch('')
    .meta({ description: 'Emotional tone (e.g., "tense", "hopeful")' }),
});

export const variantsSchema = z.object({
  cameraAngles: z
    .array(cameraAngleVariantSchema)
    .min(1)
    .max(5)
    .catch([])
    .meta({ description: 'Array of camera angle options (A1, A2, A3)' }),
  movementStyles: z
    .array(movementStyleVariantSchema)
    .min(1)
    .max(5)
    .catch([])
    .meta({ description: 'Array of movement style options (B1, B2, B3)' }),
  moodTreatments: z
    .array(moodTreatmentVariantSchema)
    .min(1)
    .max(5)
    .catch([])
    .meta({ description: 'Array of mood treatment options (C1, C2, C3)' }),
});

// ============================================================================
// Selected Variant Schema
// ============================================================================

export const selectedVariantSchema = z.object({
  cameraAngle: z
    .enum(['A1', 'A2', 'A3'])
    .catch('A1')
    .meta({ description: 'Selected camera angle option (A1, A2, or A3)' }),
  movementStyle: z
    .enum(['B1', 'B2', 'B3'])
    .catch('B1')
    .meta({ description: 'Selected movement style option (B1, B2, or B3)' }),
  moodTreatment: z
    .enum(['C1', 'C2', 'C3'])
    .catch('C1')
    .meta({ description: 'Selected mood treatment option (C1, C2, or C3)' }),
  rationale: z
    .string()
    .catch('')
    .meta({ description: 'Explanation for why these variants were chosen' }),
});

// ============================================================================
// Prompt Schemas
// ============================================================================

export const visualPromptComponentsSchema = z.object({
  sceneDescription: z
    .string()
    .catch('')
    .meta({ description: 'Overall scene action and composition description' }),
  subject: z
    .string()
    .catch('')
    .meta({ description: 'Main subject or character focus' }),
  environment: z
    .string()
    .catch('')
    .meta({ description: 'Setting, location, and background details' }),
  lighting: z
    .string()
    .catch('')
    .meta({ description: 'Light sources, quality, direction, and mood' }),
  camera: z
    .string()
    .catch('')
    .meta({ description: 'Camera angle, lens choice, and framing' }),
  composition: z
    .string()
    .catch('')
    .meta({ description: 'Visual arrangement and focal points' }),
  style: z
    .string()
    .catch('')
    .meta({ description: 'Artistic style and visual treatment' }),
  technical: z.string().catch('').meta({
    description: 'Technical parameters: resolution, quality settings',
  }),
  atmosphere: z
    .string()
    .catch('')
    .meta({ description: 'Mood, emotion, and ambient feeling' }),
});

export const visualPromptSchema = z.object({
  fullPrompt: z.string().meta({
    description: 'Complete image generation prompt with all visual details',
  }),
  negativePrompt: z
    .string()
    .catch('')
    .meta({ description: 'Elements to avoid in the generated image' }),
  components: visualPromptComponentsSchema.meta({
    description: 'Structured breakdown of the visual prompt components',
  }),
});

export const motionPromptComponentsSchema = z.object({
  cameraMovement: z.string().catch('').meta({
    description: 'Type of camera motion (pan, tilt, dolly, truck, zoom)',
  }),
  startPosition: z
    .string()
    .catch('')
    .meta({ description: 'Camera starting position and framing' }),
  endPosition: z
    .string()
    .catch('')
    .meta({ description: 'Camera ending position and framing' }),
  durationSeconds: z
    .number()
    .catch(3)
    .meta({ description: 'Shot duration in seconds (typically 3-15)' }),
  speed: z
    .string()
    .catch('medium')
    .meta({ description: 'Movement speed: slow, medium, fast' }),
  smoothness: z.string().catch('smooth').meta({
    description: 'Motion quality: jerky, natural, smooth, ultra-smooth',
  }),
  subjectTracking: z
    .string()
    .catch('')
    .meta({ description: 'How camera follows subject movement' }),
  equipment: z.string().catch('').meta({
    description: 'Suggested equipment: handheld, gimbal, dolly, crane',
  }),
});

export const motionPromptParametersSchema = z
  .object({
    durationSeconds: z
      .number()
      .meta({ description: 'Override duration in seconds' }),
    fps: z
      .number()
      .catch(30)
      .meta({ description: 'Frames per second (24, 30, 60)' }),
    motionAmount: z
      .string()
      .transform((v) => v.toLowerCase())
      .pipe(z.enum(['low', 'medium', 'high']))
      .catch('medium')
      .meta({ description: 'Amount of motion: low, medium, high' }),
    cameraControl: z
      .object({
        pan: z
          .number()
          .catch(0)
          .meta({ description: 'Horizontal rotation in degrees' }),
        tilt: z
          .number()
          .catch(0)
          .meta({ description: 'Vertical rotation in degrees' }),
        zoom: z
          .number()
          .catch(0)
          .meta({ description: 'Zoom factor (1.0 = no zoom)' }),
        movement: z
          .string()
          .catch('')
          .meta({ description: 'Direction of camera movement' }),
      })
      .catch({ pan: 0, tilt: 0, zoom: 0, movement: '' })
      .meta({ description: 'Precise camera control parameters' }),
  })
  .catch({
    durationSeconds: 3,
    fps: 30,
    motionAmount: 'medium',
    cameraControl: { pan: 0, tilt: 0, zoom: 0, movement: '' },
  });

export const dialogueLineSchema = z.object({
  character: z.string().catch('').meta({
    description: 'Character name speaking the line, or empty for narrator',
  }),
  line: z.string().catch('').meta({ description: 'The spoken dialogue text' }),
  tone: z.string().catch('').meta({
    description:
      'Voice tone and emotion for delivery (e.g., "calm serious", "trembling frustrated", "whispered urgent")',
  }),
});

export const dialogueSchema = z.object({
  presence: z
    .boolean()
    .catch(false)
    .meta({ description: 'Whether dialogue is present in scene' }),
  lines: z
    .array(dialogueLineSchema)
    .catch([])
    .meta({ description: 'Array of dialogue lines in the scene' }),
});

export const motionAudioSchema = z.object({
  ambientSound: z.string().catch('').meta({
    description:
      'Background ambient sound (e.g., "quiet office hum", "rain against windows", "bustling street")',
  }),
  soundEffects: z.array(z.string()).catch([]).meta({
    description:
      'Specific sound effects timed to actions (e.g., "door slam", "glass clinking", "footsteps on gravel")',
  }),
});

export const motionPromptSchema = z.object({
  fullPrompt: z.string().meta({
    description:
      'Complete motion prompt describing camera movement, action, and dialogue performance',
  }),
  components: motionPromptComponentsSchema
    .catch({
      cameraMovement: '',
      startPosition: '',
      endPosition: '',
      durationSeconds: 3,
      speed: 'medium',
      smoothness: 'smooth',
      subjectTracking: '',
      equipment: '',
    })
    .meta({ description: 'Structured breakdown of motion prompt components' }),
  parameters: motionPromptParametersSchema.meta({
    description: 'Technical parameters for motion generation',
  }),
  dialogue: dialogueSchema
    .catch({ presence: false, lines: [] })
    .optional()
    .meta({
      description:
        'Dialogue lines from the scene to inform audio/motion models',
    }),
  audio: motionAudioSchema
    .catch({ ambientSound: '', soundEffects: [] })
    .optional()
    .meta({
      description:
        'Audio direction for models that generate sound alongside video',
    }),
});

export const promptsSchema = z.object({
  visual: visualPromptSchema
    .optional()
    .meta({ description: 'Image generation prompt data' }),
  motion: motionPromptSchema
    .optional()
    .meta({ description: 'Motion/video generation prompt data' }),
});

// ============================================================================
// Music Design Schema (replaces audioDesign for new frames)
// ============================================================================

export const musicDesignSchema = z.object({
  presence: z.enum(['none', 'minimal', 'moderate', 'full']).meta({
    description:
      'How prominent the music should be: none, minimal, moderate, full',
  }),
  style: z.string().catch('').meta({
    description:
      'Music genre or style (e.g., "orchestral", "electronic ambient")',
  }),
  mood: z.string().catch('').meta({
    description: 'Emotional quality of the music (e.g., "tense", "uplifting")',
  }),
  atmosphere: z.string().catch('').meta({
    description: 'Environmental atmosphere (e.g., "busy city street")',
  }),
});

// ============================================================================
// Audio Design Schemas (deprecated — kept for backward compat with old frames)
// ============================================================================

export const musicSchema = z.object({
  presence: z.enum(['none', 'minimal', 'moderate', 'full']).meta({
    description:
      'How prominent the music should be: none, minimal, moderate, full',
  }),
  style: z.string().catch('').meta({
    description:
      'Music genre or style (e.g., "orchestral", "electronic ambient")',
  }),
  mood: z.string().catch('').meta({
    description: 'Emotional quality of the music (e.g., "tense", "uplifting")',
  }),
  rationale: z
    .string()
    .catch('')
    .meta({ description: 'Explanation for the music choices' }),
});

export const soundEffectSchema = z.object({
  sfxId: z
    .string()
    .catch('')
    .meta({ description: 'Unique identifier for this sound effect' }),
  type: z.string().catch('ambient').meta({
    description: 'Sound effect category (e.g., "ambient", "foley", "impact")',
  }),
  description: z.string().catch('').meta({
    description: 'Description of the sound (e.g., "distant thunder rumble")',
  }),
  timing: z.string().catch('').meta({
    description: 'When the sound plays (e.g., "scene start", "on action")',
  }),
  volume: z
    .string()
    .transform((v) => v.toLowerCase())
    .pipe(z.enum(['low', 'medium', 'high']))
    .catch('medium')
    .meta({ description: 'Relative volume level: low, medium, high' }),
  spatialPosition: z
    .string()
    .catch('center')
    .meta({ description: 'Audio positioning: left, center, right, surround' }),
});

export const ambientSchema = z.object({
  roomTone: z.string().catch('').meta({
    description: 'Background room ambience (e.g., "quiet office hum")',
  }),
  atmosphere: z.string().catch('').meta({
    description: 'Environmental atmosphere (e.g., "busy city street")',
  }),
});

export const audioDesignSchema = z.object({
  music: musicSchema
    .catch({ presence: 'none', style: '', mood: '', rationale: '' })
    .meta({ description: 'Background music specifications' }),
  soundEffects: z
    .array(soundEffectSchema)
    .catch([])
    .meta({ description: 'Array of sound effects for the scene' }),
  dialogue: dialogueSchema
    .catch({ presence: false, lines: [] })
    .meta({ description: 'Dialogue and speech specifications' }),
  ambient: ambientSchema
    .catch({ roomTone: '', atmosphere: '' })
    .meta({ description: 'Ambient sound design' }),
});

// ============================================================================
// Continuity Schema
// ============================================================================

export const continuitySchema = z.object({
  characterTags: z.array(z.string()).catch([]).meta({
    description:
      "Snake_case slug of each character's name as written in the script (e.g., 'GIRL ONE' → 'girl_one'). Optional descriptive context may be appended after the name slug (e.g., 'girl_one_bathroom_morning'). One entry per character appearing in the scene.",
  }),
  environmentTag: z
    .string()
    .catch('')
    .meta({ description: 'Location/setting tag for environment consistency' }),
  elementTags: z.array(z.string()).optional().catch([]).meta({
    description:
      'UPPERCASE tokens for user-uploaded elements referenced in this scene',
  }),
  colorPalette: z
    .string()
    .catch('')
    .meta({ description: 'Dominant colors for visual continuity' }),
  lightingSetup: z.string().catch('').meta({
    description: 'Lighting configuration for consistency across shots',
  }),
  styleTag: z
    .string()
    .catch('')
    .meta({ description: 'Visual style reference for consistent look' }),
});

/**
 * Combined schema for visual prompt generation response.
 * Used by visual-prompt-scene-workflow to capture both prompt AND continuity.
 */
export const visualPromptWithContinuitySchema = z.object({
  visual: visualPromptSchema.meta({
    description: 'Image generation prompt data',
  }),
  continuity: continuitySchema.meta({
    description:
      'Continuity tracking - characterTags and environmentTag for matching to bibles',
  }),
});

// ============================================================================
// Original Script Schema
// ============================================================================

export const originalScriptSchema = z.object({
  extract: z
    .string()
    .catch('')
    .meta({ description: 'Original script text for this scene' }),
  dialogue: z
    .array(dialogueLineSchema)
    .catch([])
    .meta({ description: 'Dialogue lines extracted from the script' }),
});

// ============================================================================
// Scene Metadata Schema
// ============================================================================

export const sceneMetadataSchema = z.object({
  title: z
    .string()
    .catch('Untitled Scene')
    .meta({ description: 'Short descriptive scene title' }),
  durationSeconds: z.number().catch(3).meta({
    description: 'Estimated scene duration in seconds (typically 3-15)',
  }),
  location: z
    .string()
    .catch('')
    .meta({ description: 'Scene location (e.g., "INT. OFFICE - DAY")' }),
  timeOfDay: z
    .string()
    .catch('')
    .meta({ description: 'Time of day: day, night, dawn, dusk, etc.' }),
  storyBeat: z
    .string()
    .catch('')
    .meta({ description: 'Narrative purpose of this scene in the story' }),
});

// ============================================================================
// Scene Schema
// ============================================================================

export const sceneSchema = z.object({
  sceneId: z
    .string()
    .meta({ description: 'Unique identifier for this scene (required)' }),
  sceneNumber: z
    .number()
    .meta({ description: 'Scene order number starting from 1 (required)' }),
  originalScript: originalScriptSchema
    .catch({ extract: '', dialogue: [] })
    .meta({ description: 'Original script content for this scene' }),
  metadata: sceneMetadataSchema
    .optional()
    .meta({ description: 'Scene metadata and context' }),
  prompts: promptsSchema.optional().meta({
    description: 'Visual and motion generation prompts',
  }),
  musicDesign: musicDesignSchema
    .optional()
    .meta({ description: 'Music classification for this scene (new frames)' }),
  /** @deprecated Kept for backward compat with old frames — use musicDesign */
  audioDesign: audioDesignSchema
    .optional()
    .meta({ description: 'Audio and sound design specs (deprecated)' }),
  continuity: continuitySchema
    .optional()
    .meta({ description: 'Continuity tracking for scene consistency' }),
  sourceImageUrl: z
    .string()
    .optional()
    .meta({ description: 'URL of generated or uploaded source image' }),
});

// ============================================================================
// Top-Level Scene Analysis Schema
// ============================================================================

export const sceneAnalysisSchema = z.object({
  status: z
    .enum(['success', 'error', 'rejected'])
    .meta({ description: 'Processing status: success, error, or rejected' }),
  projectMetadata: projectMetadataSchema
    .catch({ title: 'Untitled', aspectRatio: '16:9', generatedAt: '' })
    .meta({ description: 'Project-level metadata extracted from script' }),
  characterBible: z
    .array(characterBibleEntrySchema)
    .catch([])
    .meta({ description: 'Character descriptions for visual consistency' }),
  locationBible: z
    .array(locationBibleEntrySchema)
    .catch([])
    .meta({ description: 'Location descriptions for visual consistency' }),
  elementBible: z.array(elementBibleEntrySchema).optional().catch([]).meta({
    description:
      'User-uploaded element descriptions (logos, products) with UPPERCASE script tokens',
  }),
  scenes: z
    .array(sceneSchema)
    .meta({ description: 'Array of analyzed scenes from the script' }),
});

// ============================================================================
// TypeScript Type Export
// ============================================================================

export type SceneAnalysis = z.infer<typeof sceneAnalysisSchema>;
export type Scene = z.infer<typeof sceneSchema>;
export type CharacterBibleEntry = z.infer<typeof characterBibleEntrySchema>;
export type LocationBibleEntry = z.infer<typeof locationBibleEntrySchema>;
export type ElementBibleEntry = z.infer<typeof elementBibleEntrySchema>;
export type ProjectMetadata = z.infer<typeof projectMetadataSchema>;
export type VisualPrompt = z.infer<typeof visualPromptSchema>;
export type VisualPromptComponents = z.infer<
  typeof visualPromptComponentsSchema
>;
export type VisualPromptWithContinuity = z.infer<
  typeof visualPromptWithContinuitySchema
>;
export type MotionPrompt = z.infer<typeof motionPromptSchema>;
export type MotionPromptComponents = z.infer<
  typeof motionPromptComponentsSchema
>;
export type MotionPromptParameters = z.infer<
  typeof motionPromptParametersSchema
>;
export type MotionAudio = z.infer<typeof motionAudioSchema>;
export type DialogueLine = z.infer<typeof dialogueLineSchema>;
export type MusicDesign = z.infer<typeof musicDesignSchema>;
export type AudioDesign = z.infer<typeof audioDesignSchema>;
export type Continuity = z.infer<typeof continuitySchema>;
