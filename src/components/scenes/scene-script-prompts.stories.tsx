import type { Frame } from '@/lib/db/schema';
import type { ShotWithImage } from '@/lib/shots/shot-with-image';
import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { SceneScriptPrompts, type TabValue } from './scene-script-prompts';

// The still-image surface moved off `shots` onto the anchor `frame` in #989;
// the component reads the legacy projected names (`thumbnail*`/`image*`), so the
// fixture keeps them and adds the raw anchor `frame`.
const mockShot = {
  id: 'shot-1',
  sequenceId: 'seq-1',
  sceneId: null,
  shotNumber: null,
  orderIndex: 0,
  description: 'A bustling coffee shop interior during morning rush hour',
  durationMs: 3000,
  thumbnailUrl: 'https://picsum.photos/seed/coffee/320/180',
  thumbnailPath: 'teams/mock/sequences/mock/frames/shot-1/thumbnail.jpg',
  variantImageUrl: null,
  variantImageStatus: 'pending',
  videoUrl: null,
  videoPath: null,
  thumbnailStatus: 'completed',
  videoStatus: 'pending',
  thumbnailWorkflowRunId: null,
  thumbnailGeneratedAt: null,
  thumbnailError: null,
  imageModel: 'nano_banana',
  imagePrompt: null,
  videoWorkflowRunId: null,
  videoGeneratedAt: null,
  videoError: null,
  motionPrompt: null,
  motionModel: 'veo3',
  selectedMotionPromptVersionId: null,
  renderSegmentId: null,
  audioUrl: null,
  audioPath: null,
  audioStatus: 'pending',
  audioWorkflowRunId: null,
  audioGeneratedAt: null,
  audioError: null,
  audioModel: null,
  thumbnailInputHash: null,
  videoInputHash: null,
  audioInputHash: null,
  visualPromptInputHash: null,
  motionPromptInputHash: null,
  previewThumbnailUrl: null,
  metadata: {
    sceneId: 'scene-1',
    sceneNumber: 1,
    originalScript: {
      extract:
        'INT. COFFEE SHOP - MORNING\n\nSARAH sits at a corner table, typing furiously on her laptop. Steam rises from her untouched latte.',
      dialogue: [
        {
          character: 'SARAH',
          line: 'This deadline is going to kill me.',
          tone: '',
        },
      ],
    },
    metadata: {
      title: 'Coffee Shop Introduction',
      durationSeconds: 3,
      location: 'Coffee Shop',
      timeOfDay: 'Morning',
      storyBeat: 'Establish protagonist stress and setting',
    },
    continuity: {
      characterTags: [],
      environmentTag: '',
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
    musicDesign: {
      presence: 'none',
      style: '',
      mood: '',
      atmosphere: '',
    },
    prompts: {
      visual: {
        fullPrompt:
          'Busy coffee shop interior, morning light streaming through windows, woman sitting at corner table with laptop, steam rising from latte cup, warm atmosphere, cinematic lighting, 4K sharp focus',
        negativePrompt: 'blurry, low quality, distorted',
        components: {
          sceneDescription: 'Coffee shop',
          subject: 'Woman at laptop',
          environment: 'Interior cafe',
          lighting: 'Natural morning light',
          camera: 'Medium shot',
          composition: 'Rule of thirds',
          style: 'Cinematic',
          technical: '4K, sharp focus',
          atmosphere: 'Bustling yet intimate',
        },
      },
      motion: {
        fullPrompt:
          'Slow push in, subtle camera movement forward, dolly shot from wide to medium, very smooth transition, locked subject tracking',
        components: {
          cameraMovement: 'Push in',
          startPosition: 'Wide',
          endPosition: 'Medium',
          durationSeconds: 3,
          speed: 'Slow',
          smoothness: 'Very smooth',
          subjectTracking: 'Locked',
          equipment: 'Dolly',
        },
        parameters: {
          durationSeconds: 3,
          fps: 24,
          motionAmount: 'medium' as const,
          cameraControl: {
            pan: 0,
            tilt: 0,
            zoom: 0.2,
            movement: 'forward',
          },
        },
      },
    },
    sourceImageUrl: '',
  },
  createdAt: new Date(),
  updatedAt: new Date(),
  frame: {
    id: 'shot-1',
    shotId: 'shot-1',
    sequenceId: 'seq-1',
    orderIndex: 0,
    role: 'first',
    source: 'generated',
    imageUrl: 'https://picsum.photos/seed/coffee/320/180',
    previewImageUrl: null,
    imagePath: 'teams/mock/sequences/mock/frames/shot-1/thumbnail.jpg',
    imageStatus: 'completed',
    imageWorkflowRunId: null,
    imageGeneratedAt: null,
    imageError: null,
    imageModel: 'nano_banana',
    imagePrompt: null,
    selectedImageVersionId: null,
    selectedImagePromptVersionId: null,
    imageInputHash: null,
    visualPromptInputHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  } satisfies Frame,
} satisfies ShotWithImage;

const meta: Meta<typeof SceneScriptPrompts> = {
  title: 'Scenes/SceneScriptPrompts',
  component: SceneScriptPrompts,
  parameters: {
    layout: 'centered',
  },
  args: {
    sequenceId: 'seq-1',
    selectedTab: 'script' as TabValue,
    onTabChange: fn(),
    regeneratingImages: new Set<string>(),
    regeneratingMotion: new Set<string>(),
    regeneratingSceneVariants: new Set<string>(),
    onRegenerateStart: fn(),
    // Scene-level model selection (#909) — these are required props; without
    // them IMAGE_TO_VIDEO_MODELS[undefined] is undefined and the component
    // crashes on `'requiredStyleCategory' in undefined`.
    sceneImageModel: 'gpt_image_2',
    sceneVideoModel: 'seedance_v2',
  },
  decorators: [
    (Story) => (
      <div className="w-[600px]">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SceneScriptPrompts>;

export const Default: Story = {
  args: {
    shot: mockShot,
  },
};

export const Loading: Story = {
  args: {
    shot: undefined,
  },
};

export const PartiallyLoaded: Story = {
  args: {
    shot: {
      ...mockShot,
      metadata: null,
    },
  },
};

export const LongScript: Story = {
  args: {
    shot: {
      ...mockShot,
      durationMs: 8500,
      metadata: {
        ...mockShot.metadata,
        originalScript: {
          extract: `INT. COFFEE SHOP - MORNING

SARAH sits at a corner table, typing furiously on her laptop. Steam rises from her untouched latte. The morning sun streams through large windows, casting long shadows across the wooden floor.

Other patrons bustle about, ordering drinks and chatting, creating a backdrop of ambient noise that Sarah tries to tune out. Her phone BUZZES. She glances at it, frowns, and silences it without reading the message.

BARISTA (O.S.)
    Large oat milk latte for Sarah!

Sarah doesn't respond, too absorbed in her work. The barista shrugs and sets the drink aside.`,
          dialogue: [
            {
              character: 'BARISTA',
              line: 'Large oat milk latte for Sarah!',
              tone: '',
            },
          ],
        },
      },
    },
  },
};

export const LongPrompts: Story = {
  args: {
    shot: {
      ...mockShot,
      metadata: {
        ...mockShot.metadata,
        prompts: {
          visual: {
            fullPrompt:
              'Busy coffee shop interior, morning light streaming through large windows casting long dramatic shadows across wooden floor, woman in casual business attire sitting at corner table with laptop, steam rising from latte cup on table, warm cozy atmosphere with bustling patrons in soft focus background, cinematic lighting with natural window light as key, shallow depth of field, 4K ultra sharp focus, professionally color graded, film grain texture',
            negativePrompt: 'blurry, low quality, distorted',
            components: {
              sceneDescription: 'Coffee shop',
              subject: 'Woman at laptop',
              environment: 'Interior cafe',
              lighting: 'Natural morning light',
              camera: 'Medium shot',
              composition: 'Rule of thirds',
              style: 'Cinematic',
              technical: '4K, sharp focus',
              atmosphere: 'Bustling yet intimate',
            },
          },
          motion: {
            fullPrompt:
              'Slow deliberate push in, subtle smooth camera movement forward using dolly equipment, starting from wide establishing shot transitioning to medium intimate shot, very smooth fluid transition at constant slow speed, locked subject tracking maintaining focus on protagonist, professional cinematography technique, 3 second duration, 24fps cinematic frame rate',
            components: {
              cameraMovement: 'Push in',
              startPosition: 'Wide',
              endPosition: 'Medium',
              durationSeconds: 3,
              speed: 'Slow',
              smoothness: 'Very smooth',
              subjectTracking: 'Locked',
              equipment: 'Dolly',
            },
            parameters: {
              durationSeconds: 3,
              fps: 24,
              motionAmount: 'medium' as const,
              cameraControl: {
                pan: 0,
                tilt: 0,
                zoom: 0.2,
                movement: 'forward',
              },
            },
          },
        },
      },
    },
  },
};

export const ShortScript: Story = {
  args: {
    shot: {
      ...mockShot,
      durationMs: 1500,
      metadata: {
        ...mockShot.metadata,
        originalScript: {
          extract: 'INT. COFFEE SHOP - MORNING\n\nSARAH types on laptop.',
          dialogue: [],
        },
      },
    },
  },
};

export const NoDuration: Story = {
  args: {
    shot: {
      ...mockShot,
      durationMs: null,
    },
  },
};
