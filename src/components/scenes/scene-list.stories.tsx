import { generateMockFrames } from '@/lib/mocks/data-generators';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import type { Meta, StoryObj } from '@storybook/react';
import { SceneList } from './scene-list';

const meta: Meta<typeof SceneList> = {
  title: 'Scenes/SceneList',
  component: SceneList,
  decorators: [
    (Story) => (
      <div className="h-screen">
        <Story />
      </div>
    ),
  ],
  parameters: {
    layout: 'fullscreen',
  },
  args: {
    shots: [],
    selectedFrameId: undefined,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    onSelectShot: () => console.log('onSelectShot'),
    regeneratingImages: new Set<string>(),
    regeneratingMotion: new Set<string>(),
    musicPromptsReady: false,
  },
};

export default meta;
type Story = StoryObj<typeof SceneList>;

// Generate mock frames for different scenarios
const mockFrames = generateMockFrames(5, 'mock-sequence-id');

export const WithScenes: Story = {
  args: {
    shots: mockFrames,
    selectedFrameId: mockFrames[1]?.id ?? undefined,
  },
};

export const NoSelectedScene: Story = {
  args: {
    shots: mockFrames,
    selectedFrameId: undefined,
  },
};

export const MultipleCompleted: Story = {
  args: {
    shots: mockFrames,
    selectedFrameId: mockFrames[0]?.id ?? undefined,
  },
};

export const AllCompleted: Story = {
  args: {
    shots: mockFrames,
    selectedFrameId: undefined,
  },
};

export const Empty: Story = {
  args: {
    shots: [],
    selectedFrameId: undefined,
  },
};

export const ManyScenes: Story = {
  args: {
    shots: generateMockFrames(15, 'mock-sequence-id'),
    selectedFrameId: undefined,
  },
};

export const GeneratingThumbnails: Story = {
  args: {
    shots: mockFrames.map((frame, idx) => ({
      ...frame,
      thumbnailStatus:
        idx < 3 ? ('generating' as const) : ('completed' as const),
      thumbnailUrl: idx < 3 ? null : frame.thumbnailUrl,
    })),
    selectedFrameId: mockFrames[0]?.id ?? undefined,
  },
};

export const WithFailures: Story = {
  args: {
    shots: mockFrames.map((frame, idx) => ({
      ...frame,
      thumbnailStatus: idx === 2 ? ('failed' as const) : ('completed' as const),
      thumbnailUrl: idx === 2 ? null : frame.thumbnailUrl,
      thumbnailError: idx === 2 ? 'Generation timeout' : null,
    })),
    selectedFrameId: undefined,
  },
};

export const MixedStates: Story = {
  args: {
    shots: mockFrames.map((frame, idx) => {
      if (idx === 0) {
        return {
          ...frame,
          thumbnailStatus: 'pending' as const,
          thumbnailUrl: null,
        };
      }
      if (idx === 1) {
        return {
          ...frame,
          thumbnailStatus: 'generating' as const,
          thumbnailUrl: null,
        };
      }
      if (idx === 2) {
        return {
          ...frame,
          thumbnailStatus: 'failed' as const,
          thumbnailUrl: null,
          thumbnailError: 'API error',
        };
      }
      return {
        ...frame,
        thumbnailStatus: 'completed' as const,
      };
    }),
    selectedFrameId: mockFrames[1]?.id ?? undefined,
  },
};

// Width variations
export const WidthMedium: Story = {
  args: {
    shots: mockFrames,
    selectedFrameId: mockFrames[1]?.id ?? undefined,
  },
  decorators: [
    (Story) => (
      <div className="h-screen">
        <div className="[&>div]:w-96">
          <Story />
        </div>
      </div>
    ),
  ],
};

export const WidthLarge: Story = {
  args: {
    shots: mockFrames,
    selectedFrameId: mockFrames[1]?.id ?? undefined,
  },
  decorators: [
    (Story) => (
      <div className="h-screen">
        <div className="[&>div]:w-lg">
          <Story />
        </div>
      </div>
    ),
  ],
};

export const WidthExtraLarge: Story = {
  args: {
    shots: mockFrames,
    selectedFrameId: mockFrames[1]?.id ?? undefined,
  },
  decorators: [
    (Story) => (
      <div className="h-screen">
        <div className="[&>div]:w-xl">
          <Story />
        </div>
      </div>
    ),
  ],
};
