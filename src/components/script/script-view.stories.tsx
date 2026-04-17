import type { Meta, StoryObj } from '@storybook/react-vite';

import type { Sequence } from '@/lib/db/schema/sequences';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ScriptView } from './script-view';

// Mock sequence for edit mode stories
const mockSequence: Sequence = {
  id: 'demo-sequence-123',
  teamId: 'demo-team',
  title: 'Demo Video Sequence',
  script: `INT. OFFICE - DAY

Sarah sits at her desk, typing furiously on her laptop. The phone RINGS.

SARAH
(frustrated)
Not now...

She answers anyway, her expression softening.

SARAH (CONT'D)
Oh, hi Mom. Yeah, I'm fine. Just... working on a big project.`,
  status: 'draft',
  createdAt: new Date('2024-01-15T10:30:00Z'),
  updatedAt: new Date('2024-01-15T10:30:00Z'),
  createdBy: null,
  updatedBy: null,
  styleId: 'style-1',
  aspectRatio: '16:9',
  analysisModel: 'anthropic/claude-haiku-4.5',
  analysisDurationMs: 0,
  imageModel: 'nano_banana_pro',
  videoModel: 'kling_v2_5_turbo_pro',
  workflow: null,
  mergedVideoUrl: null,
  mergedVideoPath: null,
  mergedVideoStatus: 'pending',
  mergedVideoGeneratedAt: null,
  mergedVideoError: null,
  musicUrl: null,
  musicPath: null,
  musicStatus: 'pending',
  musicGeneratedAt: null,
  musicError: null,
  musicModel: null,
  musicPrompt: null,
  musicTags: null,
  statusError: null,
  posterUrl: null,
  autoGenerateMotion: false,
  autoGenerateMusic: false,
  suggestedTalentIds: null,
  suggestedLocationIds: null,
};

// Create a new QueryClient for each story to avoid state leakage
const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: 0,
      },
      mutations: {
        retry: false,
      },
    },
  });

const meta: Meta<typeof ScriptView> = {
  title: 'Script/ScriptView',
  component: ScriptView,
  parameters: {
    layout: 'fullscreen',
    docs: {
      description: {
        component:
          'The complete new sequence creation page with all sections integrated.',
      },
    },
  },
  decorators: [
    (Story) => (
      <QueryClientProvider client={createQueryClient()}>
        <Story />
      </QueryClientProvider>
    ),
  ],
  argTypes: {
    teamId: {
      description: 'The ID of the team to create the sequence for',
      control: 'text',
    },
    sequence: {
      description: 'Full sequence object for edit mode',
      control: 'object',
    },
    loading: {
      description: 'Whether the component is in a loading state',
      control: 'boolean',
    },
    flat: {
      description: 'Whether to render without padding/margins',
      control: 'boolean',
    },
  },
};

export default meta;
type Story = StoryObj<typeof ScriptView>;

export const Default: Story = {
  args: {
    teamId: 'demo-team',
  },
  parameters: {
    docs: {
      description: {
        story:
          'Default script view showing the complete user flow from script writing to storyboard generation.',
      },
    },
  },
};

export const EditMode: Story = {
  args: {
    teamId: 'demo-team',
    sequence: mockSequence,
  },
  parameters: {
    docs: {
      description: {
        story:
          'Edit mode for updating an existing sequence. Shows the cancel button and updates the sequence instead of creating a new one.',
      },
    },
  },
};

export const Loading: Story = {
  args: {
    teamId: 'demo-team',
    sequence: mockSequence,
    loading: true,
  },
  parameters: {
    docs: {
      description: {
        story:
          'Loading state shown while the sequence is being processed or saved.',
      },
    },
  },
};
