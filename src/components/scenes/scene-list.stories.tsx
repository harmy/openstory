import { generateMockShots } from '@/lib/mocks/data-generators';
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
    selectedShotId: undefined,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    onSelectShot: () => console.log('onSelectShot'),
    regeneratingImages: new Set<string>(),
    regeneratingMotion: new Set<string>(),
    musicPromptsReady: false,
  },
};

export default meta;
type Story = StoryObj<typeof SceneList>;

// Generate mock shots for different scenarios
const mockShots = generateMockShots(5, 'mock-sequence-id');

export const WithScenes: Story = {
  args: {
    shots: mockShots,
    selectedShotId: mockShots[1]?.id ?? undefined,
  },
};

export const NoSelectedScene: Story = {
  args: {
    shots: mockShots,
    selectedShotId: undefined,
  },
};

export const MultipleCompleted: Story = {
  args: {
    shots: mockShots,
    selectedShotId: mockShots[0]?.id ?? undefined,
  },
};

export const AllCompleted: Story = {
  args: {
    shots: mockShots,
    selectedShotId: undefined,
  },
};

export const Empty: Story = {
  args: {
    shots: [],
    selectedShotId: undefined,
  },
};

export const ManyScenes: Story = {
  args: {
    shots: generateMockShots(15, 'mock-sequence-id'),
    selectedShotId: undefined,
  },
};

export const GeneratingThumbnails: Story = {
  args: {
    shots: mockShots.map((shot, idx) => ({
      ...shot,
      thumbnailStatus:
        idx < 3 ? ('generating' as const) : ('completed' as const),
      thumbnailUrl: idx < 3 ? null : shot.thumbnailUrl,
    })),
    selectedShotId: mockShots[0]?.id ?? undefined,
  },
};

export const WithFailures: Story = {
  args: {
    shots: mockShots.map((shot, idx) => ({
      ...shot,
      thumbnailStatus: idx === 2 ? ('failed' as const) : ('completed' as const),
      thumbnailUrl: idx === 2 ? null : shot.thumbnailUrl,
      thumbnailError: idx === 2 ? 'Generation timeout' : null,
    })),
    selectedShotId: undefined,
  },
};

export const MixedStates: Story = {
  args: {
    shots: mockShots.map((shot, idx) => {
      if (idx === 0) {
        return {
          ...shot,
          thumbnailStatus: 'pending' as const,
          thumbnailUrl: null,
        };
      }
      if (idx === 1) {
        return {
          ...shot,
          thumbnailStatus: 'generating' as const,
          thumbnailUrl: null,
        };
      }
      if (idx === 2) {
        return {
          ...shot,
          thumbnailStatus: 'failed' as const,
          thumbnailUrl: null,
          thumbnailError: 'API error',
        };
      }
      return {
        ...shot,
        thumbnailStatus: 'completed' as const,
      };
    }),
    selectedShotId: mockShots[1]?.id ?? undefined,
  },
};

// Width variations
export const WidthMedium: Story = {
  args: {
    shots: mockShots,
    selectedShotId: mockShots[1]?.id ?? undefined,
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
    shots: mockShots,
    selectedShotId: mockShots[1]?.id ?? undefined,
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
    shots: mockShots,
    selectedShotId: mockShots[1]?.id ?? undefined,
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
