import type { Meta, StoryObj } from '@storybook/react';
import { fn } from 'storybook/test';
import { TheatreView } from './theatre-view';
import type { Sequence } from '@/types/database';

const baseSequence: Sequence = {
  id: 'seq_123',
  teamId: 'team_123',
  title: 'My Awesome Sequence',
  script: 'A short film about nature.',
  status: 'completed',
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: 'user_123',
  updatedBy: 'user_123',
  styleId: 'style_123',
  aspectRatio: '16:9',
  analysisModel: 'anthropic/claude-haiku-4.5',
  analysisDurationMs: 5000,
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

const meta: Meta<typeof TheatreView> = {
  title: 'Theatre/TheatreView',
  component: TheatreView,
  parameters: {
    layout: 'padded',
  },
  args: {
    onGenerateMergedVideo: fn(),
  },
};

export default meta;
type Story = StoryObj<typeof TheatreView>;

export const Pending: Story = {
  args: {
    sequence: {
      ...baseSequence,
      mergedVideoStatus: 'pending',
    },
  },
};

export const Merging: Story = {
  args: {
    sequence: {
      ...baseSequence,
      mergedVideoStatus: 'merging',
    },
  },
};

export const Completed: Story = {
  args: {
    sequence: {
      ...baseSequence,
      mergedVideoStatus: 'completed',
      mergedVideoUrl:
        'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      mergedVideoPath:
        'teams/team_123/sequences/seq_123/merged/abc123_openstory.mp4',
      mergedVideoGeneratedAt: new Date(),
    },
  },
};

export const CompletedPortrait: Story = {
  args: {
    sequence: {
      ...baseSequence,
      aspectRatio: '9:16',
      mergedVideoStatus: 'completed',
      mergedVideoUrl:
        'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
      mergedVideoPath:
        'teams/team_123/sequences/seq_123/merged/abc123_openstory.mp4',
      mergedVideoGeneratedAt: new Date(),
    },
  },
};

export const Failed: Story = {
  args: {
    sequence: {
      ...baseSequence,
      mergedVideoStatus: 'failed',
      mergedVideoError: 'Failed to download video segment from storage',
    },
  },
};

export const FailedWithRetrying: Story = {
  args: {
    sequence: {
      ...baseSequence,
      mergedVideoStatus: 'failed',
      mergedVideoError: 'Network timeout during merge operation',
    },
    isGenerating: true,
  },
};

export const PendingWithGenerating: Story = {
  args: {
    sequence: {
      ...baseSequence,
      mergedVideoStatus: 'pending',
    },
    isGenerating: true,
  },
};
