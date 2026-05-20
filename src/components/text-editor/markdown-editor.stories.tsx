import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { MarkdownEditor } from './markdown-editor';

const meta: Meta<typeof MarkdownEditor> = {
  title: 'UI/MarkdownEditor',
  component: MarkdownEditor,
  parameters: {
    layout: 'padded',
    docs: {
      description: {
        component:
          'A WYSIWYG markdown editor that live-transforms markdown syntax (e.g. `# ` → heading, `**bold**` → bold) as you type. Wraps TipTap v3 with `tiptap-markdown` for bidirectional markdown serialization. Drop-in replacement for `<Textarea>` with `value` / `onValueChange`.',
      },
    },
  },
};

export default meta;
type Story = StoryObj<typeof MarkdownEditor>;

const Interactive: React.FC<
  Omit<
    React.ComponentProps<typeof MarkdownEditor>,
    'value' | 'onValueChange'
  > & {
    initialValue?: string;
  }
> = ({ initialValue = '', ...rest }) => {
  const [value, setValue] = useState(initialValue);
  return (
    <div className="space-y-2">
      <MarkdownEditor value={value} onValueChange={setValue} {...rest} />
      <pre className="text-xs text-muted-foreground whitespace-pre-wrap rounded-md border p-2 max-h-40 overflow-auto">
        {value || '(empty)'}
      </pre>
    </div>
  );
};

export const Default: Story = {
  render: () => <Interactive placeholder="Type some markdown…" />,
};

export const WithContent: Story = {
  render: () => (
    <Interactive
      initialValue={`# The Coffee Shop\n\n**INT. COFFEE SHOP - DAY**\n\nA bustling street corner coffee shop with large windows overlooking the city.\n\n*Sarah sits by the window, fingers hovering over her keyboard.*\n\n- Take a deep breath\n- Begin to type`}
    />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Pre-populated with screenplay-style markdown. Headings, bold, italic, and lists render live.',
      },
    },
  },
};

export const Disabled: Story = {
  render: () => (
    <Interactive
      initialValue="# Locked\n\nThis content **cannot** be edited."
      disabled
    />
  ),
};

export const WithError: Story = {
  render: () => (
    <Interactive initialValue="Some content with an error state" aria-invalid />
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Editor with `aria-invalid` set — destructive border + ring matches the Textarea error treatment.',
      },
    },
  },
};

export const AutoFocused: Story = {
  render: () => (
    // eslint-disable-next-line jsx-a11y/no-autofocus -- exercising the prop is the point
    <Interactive placeholder="I should be focused on load" autoFocus />
  ),
};

const StreamingDemo: React.FC = () => {
  const target = `# Streaming Test\n\nThe quick **brown** fox jumps over the lazy dog.\n\n- one\n- two\n- three\n`;
  const [value, setValue] = useState('');
  const [running, setRunning] = useState(false);

  const start = () => {
    setRunning(true);
    setValue('');
    let i = 0;
    const tick = () => {
      i += 1;
      setValue(target.slice(0, i));
      if (i < target.length) {
        setTimeout(tick, 8);
      } else {
        setRunning(false);
      }
    };
    setTimeout(tick, 0);
  };

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={start}
        disabled={running}
        className="rounded border px-3 py-1 text-sm disabled:opacity-50"
      >
        {running ? 'Streaming…' : 'Start streaming'}
      </button>
      <MarkdownEditor value={value} onValueChange={setValue} />
      <pre className="text-xs text-muted-foreground whitespace-pre-wrap rounded-md border p-2 max-h-40 overflow-auto">
        {value || '(empty)'}
      </pre>
    </div>
  );
};

export const Streaming: Story = {
  render: () => <StreamingDemo />,
  parameters: {
    docs: {
      description: {
        story:
          'Simulates LLM streaming: rapid external `value` updates (one character per ~8ms). Verifies the editor stays in sync with parent state and never drops chunks.',
      },
    },
  },
};

export const LongContent: Story = {
  render: () => (
    <div className="h-[300px] flex">
      <Interactive
        className="flex-1"
        initialValue={Array.from(
          { length: 30 },
          (_, i) =>
            `## Scene ${i + 1}\n\nDescription for scene ${i + 1}. The quick brown fox jumps over the lazy dog.\n`
        ).join('\n')}
      />
    </div>
  ),
  parameters: {
    docs: {
      description: {
        story:
          'Verifies internal scrolling when content overflows the container.',
      },
    },
  },
};
