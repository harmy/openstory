import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { StalenessIndicator } from './staleness-indicator';

const meta: Meta<typeof StalenessIndicator> = {
  title: 'UI/StalenessIndicator',
  component: StalenessIndicator,
  parameters: {
    layout: 'padded',
  },
  argTypes: {
    onRegenerate: { action: 'regenerate' },
    onDismiss: { action: 'dismiss' },
    artifact: {
      control: 'select',
      options: [
        'thumbnail',
        'video',
        'audio',
        'sheet',
        'visual-prompt',
        'motion-prompt',
        'music-prompt',
      ],
    },
    entityType: {
      control: 'select',
      options: [
        'shot',
        'character',
        'location',
        'library-location',
        'talent',
        'sequence',
      ],
    },
    density: {
      control: 'radio',
      options: ['inline', 'corner-dot'],
    },
  },
  args: {
    artifact: 'thumbnail',
    entityType: 'shot',
  },
};

export default meta;
type Story = StoryObj<typeof StalenessIndicator>;

/**
 * Non-stale: when the artifact is current, the parent doesn't render the
 * indicator at all — there's no "off" prop on the primitive itself.
 */
export const NonStale: Story = {
  render: () => {
    const isStale = false;
    return (
      <div className="flex max-w-xl flex-col gap-2">
        <p className="text-sm text-muted-foreground">
          When inputs match, parent skips the indicator entirely.
        </p>
        <div className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
          {/* Story branch mirrors production gating — kept even though `isStale` is a fixed literal here. */}
          {/* oxlint-disable-next-line typescript/no-unnecessary-condition */}
          {isStale ? (
            <StalenessIndicator
              artifact="thumbnail"
              entityType="shot"
              onRegenerate={() => {}}
            />
          ) : (
            <span>(no indicator rendered)</span>
          )}
        </div>
      </div>
    );
  },
};

export const StaleInline: Story = {
  args: {
    density: 'inline',
    artifact: 'thumbnail',
    entityType: 'shot',
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
};

export const StaleInlineDismissible: Story = {
  args: {
    density: 'inline',
    artifact: 'video',
    entityType: 'shot',
    onDismiss: () => {},
  },
  decorators: [
    (Story) => (
      <div className="max-w-xl">
        <Story />
      </div>
    ),
  ],
};

export const StaleCornerDot: Story = {
  args: {
    density: 'corner-dot',
    artifact: 'thumbnail',
    entityType: 'shot',
  },
  render: (args) => (
    <Card className="relative w-72">
      <div className="absolute right-3 top-3 z-10">
        <StalenessIndicator {...args} />
      </div>
      <CardContent className="flex h-32 items-center justify-center text-sm text-muted-foreground">
        Scene card content
      </CardContent>
    </Card>
  ),
};

const SoftDismissDemo: React.FC = () => {
  const [count, setCount] = useState(0);
  return (
    <div className="flex max-w-xl flex-col gap-3">
      <StalenessIndicator
        artifact="thumbnail"
        entityType="shot"
        onRegenerate={() => setCount((c) => c + 1)}
        onDismiss={() => {}}
      />
      <p className="text-xs text-muted-foreground">
        Regenerate clicks: {count}
      </p>
    </div>
  );
};

/**
 * Demonstrates internal session-scoped soft-dismiss.
 * Click the X — the indicator disappears for this session.
 */
export const SoftDismissBehavior: Story = {
  render: () => <SoftDismissDemo />,
};
