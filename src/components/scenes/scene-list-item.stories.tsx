import type { Shot } from '@/types/database';
import type { Frame } from '@/lib/db/schema';
import {
  projectShotWithImage,
  type ShotWithImage,
} from '@/lib/shots/shot-with-image';
import type { Meta, StoryObj } from '@storybook/react';
import { SceneListItem } from './scene-list-item';

// The still IMAGE surface moved off `shots` onto the anchor frame in #989. The
// mock carries the legacy `thumbnail*`/`image*` names the card still reads (the
// `ShotWithImage` projection); mirror them back onto a concrete anchor `Frame`
// (id == shot.id) so the row matches what `getShotsFn` returns.
const toShotWithImage = (shot: Omit<ShotWithImage, 'frame'>): ShotWithImage => {
  const frame: Frame = {
    id: shot.id,
    shotId: shot.id,
    sequenceId: shot.sequenceId,
    orderIndex: 0,
    role: 'first',
    source: 'generated',
    imageUrl: shot.thumbnailUrl,
    previewImageUrl: shot.previewThumbnailUrl,
    imagePath: shot.thumbnailPath,
    imageStatus: shot.thumbnailStatus,
    imageWorkflowRunId: shot.thumbnailWorkflowRunId,
    imageGeneratedAt: shot.thumbnailGeneratedAt,
    imageError: shot.thumbnailError,
    imageModel: shot.imageModel,
    imagePrompt: shot.imagePrompt,
    selectedImageVersionId: null,
    selectedImagePromptVersionId: null,
    imageInputHash: shot.thumbnailInputHash,
    visualPromptInputHash: shot.visualPromptInputHash,
    createdAt: shot.createdAt,
    updatedAt: shot.updatedAt,
  };
  return projectShotWithImage(shot, frame, {
    url: shot.variantImageUrl,
    status: shot.variantImageStatus,
  });
};

const mockShot: ShotWithImage = toShotWithImage({
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
  motionPrompt: '',
  motionModel: 'veo3',
  selectedMotionPromptVersionId: null,
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
    prompts: {
      visual: {
        fullPrompt:
          'Busy coffee shop interior, morning light streaming through windows',
        negativePrompt: 'blurry, low quality',
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
        fullPrompt: 'Slow push in, subtle camera movement',
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
    musicDesign: {
      presence: 'none',
      style: '',
      mood: '',
      atmosphere: '',
    },
    continuity: {
      characterTags: [],
      environmentTag: '',
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
    sourceImageUrl: '',
  },
  createdAt: new Date(),
  updatedAt: new Date(),
});

const meta: Meta<typeof SceneListItem> = {
  title: 'Scenes/SceneListItem',
  component: SceneListItem,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="w-80">
        <Story />
      </div>
    ),
  ],
  args: {
    onSelect: () => console.log('onSelect'),
  },
};

export default meta;
type Story = StoryObj<typeof SceneListItem>;

export const Inactive: Story = {
  args: {
    shot: mockShot,
    isActive: false,
    isCompleted: false,
  },
};

export const Active: Story = {
  args: {
    shot: mockShot,
    isActive: true,
    isCompleted: false,
  },
};

export const Completed: Story = {
  args: {
    shot: mockShot,
    isActive: false,
    isCompleted: true,
  },
};

export const ActiveAndCompleted: Story = {
  args: {
    shot: mockShot,
    isActive: true,
    isCompleted: true,
  },
};

export const Generating: Story = {
  args: {
    shot: {
      ...mockShot,
      thumbnailUrl: null,
      thumbnailStatus: 'generating',
    },
    isActive: false,
    isCompleted: false,
  },
};

export const GeneratingActive: Story = {
  args: {
    shot: {
      ...mockShot,
      thumbnailUrl: null,
      thumbnailStatus: 'generating',
    },
    isActive: true,
    isCompleted: false,
  },
};

export const Failed: Story = {
  args: {
    shot: {
      ...mockShot,
      thumbnailUrl: null,
      thumbnailStatus: 'failed',
      thumbnailError: 'Generation timeout',
    },
    isActive: false,
    isCompleted: false,
  },
};

export const LongTitle: Story = {
  args: {
    shot: {
      ...mockShot,
      metadata: {
        sceneId: mockShot.metadata?.sceneId ?? '',
        sceneNumber: mockShot.metadata?.sceneNumber ?? 1,
        originalScript: mockShot.metadata?.originalScript ?? {
          extract: '',
          dialogue: [],
        },
        metadata: {
          title:
            'An Extremely Long Scene Title That Should Wrap Properly Without Breaking Layout',
          durationSeconds: mockShot.metadata?.metadata?.durationSeconds ?? 3,
          location: mockShot.metadata?.metadata?.location ?? '',
          timeOfDay: mockShot.metadata?.metadata?.timeOfDay ?? '',
          storyBeat: mockShot.metadata?.metadata?.storyBeat ?? '',
        },
        prompts: mockShot.metadata?.prompts ?? {
          visual: {
            fullPrompt: '',
            negativePrompt: '',
            components: {
              sceneDescription: '',
              subject: '',
              environment: '',
              lighting: '',
              camera: '',
              composition: '',
              style: '',
              technical: '',
              atmosphere: '',
            },
          },
          motion: {
            fullPrompt: '',
            components: {
              cameraMovement: '',
              startPosition: '',
              endPosition: '',
              durationSeconds: 3,
              speed: '',
              smoothness: '',
              subjectTracking: '',
              equipment: '',
            },
            parameters: {
              durationSeconds: 3,
              fps: 24,
              motionAmount: 'medium' as const,
              cameraControl: {
                pan: 0,
                tilt: 0,
                zoom: 0,
                movement: '',
              },
            },
          },
        },
        audioDesign: mockShot.metadata?.audioDesign ?? {
          music: { presence: 'none', style: '', mood: '', rationale: '' },
          soundEffects: [],
          dialogue: { presence: false, lines: [] },
          ambient: { roomTone: '', atmosphere: '' },
        },
        continuity: mockShot.metadata?.continuity ?? {
          characterTags: [],
          environmentTag: '',
          colorPalette: '',
          lightingSetup: '',
          styleTag: '',
        },
        sourceImageUrl: mockShot.metadata?.sourceImageUrl ?? '',
      } satisfies Shot['metadata'],
    },
    isActive: false,
    isCompleted: false,
  },
};

export const LongScript: Story = {
  args: {
    shot: {
      ...mockShot,
      metadata: {
        sceneId: mockShot.metadata?.sceneId ?? '',
        sceneNumber: mockShot.metadata?.sceneNumber ?? 1,
        originalScript: {
          ...(mockShot.metadata?.originalScript ?? {
            extract: '',
            dialogue: [],
          }),
          extract:
            'INT. COFFEE SHOP - MORNING\n\nSARAH sits at a corner table, typing furiously on her laptop. Steam rises from her untouched latte. The morning sun streams through large windows, casting long shadows across the wooden floor. Other patrons bustle about, ordering drinks and chatting, creating a backdrop of ambient noise that Sarah tries to tune out.',
        },
        metadata: mockShot.metadata?.metadata ?? {
          title: '',
          durationSeconds: 3,
          location: '',
          timeOfDay: '',
          storyBeat: '',
        },
        prompts: mockShot.metadata?.prompts ?? {
          visual: {
            fullPrompt: '',
            negativePrompt: '',
            components: {
              sceneDescription: '',
              subject: '',
              environment: '',
              lighting: '',
              camera: '',
              composition: '',
              style: '',
              technical: '',
              atmosphere: '',
            },
          },
          motion: {
            fullPrompt: '',
            components: {
              cameraMovement: '',
              startPosition: '',
              endPosition: '',
              durationSeconds: 3,
              speed: '',
              smoothness: '',
              subjectTracking: '',
              equipment: '',
            },
            parameters: {
              durationSeconds: 3,
              fps: 24,
              motionAmount: 'medium' as const,
              cameraControl: {
                pan: 0,
                tilt: 0,
                zoom: 0,
                movement: '',
              },
            },
          },
        },
        audioDesign: mockShot.metadata?.audioDesign ?? {
          music: { presence: 'none', style: '', mood: '', rationale: '' },
          soundEffects: [],
          dialogue: { presence: false, lines: [] },
          ambient: { roomTone: '', atmosphere: '' },
        },
        continuity: mockShot.metadata?.continuity ?? {
          characterTags: [],
          environmentTag: '',
          colorPalette: '',
          lightingSetup: '',
          styleTag: '',
        },
        sourceImageUrl: mockShot.metadata?.sourceImageUrl ?? '',
      } satisfies Shot['metadata'],
    },
    isActive: false,
    isCompleted: false,
  },
};
