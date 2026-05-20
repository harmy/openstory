import HardBreak from '@tiptap/extension-hard-break';
import { Placeholder } from '@tiptap/extensions/placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  Markdown,
  type MarkdownNodeSpec,
  type MarkdownStorage,
} from 'tiptap-markdown';
import { cn } from '@/lib/utils';
import * as React from 'react';
import { useEffect, useRef } from 'react';

declare module '@tiptap/core' {
  interface Storage {
    markdown: MarkdownStorage;
  }
}

// Override tiptap-markdown's HardBreak serializer to emit a naked `\n` instead
// of CommonMark's `\\\n`. We run with `breaks: true` on parse, so a plain `\n`
// round-trips losslessly as a hard break — and the LLM enhance request body
// then matches single-newline screenplay input verbatim (no `\\` injected),
// which keeps recorded aimock fixtures matching.
const HardBreakAsNewline = HardBreak.extend({
  addStorage() {
    const spec: MarkdownNodeSpec = {
      serialize(state, node, parent, index) {
        for (let i = index + 1; i < parent.childCount; i++) {
          if (parent.child(i).type !== node.type) {
            state.write('\n');
            return;
          }
        }
      },
    };
    return { markdown: spec };
  },
});

type MarkdownEditorProps = {
  value: string;
  onValueChange: (markdown: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
  onKeyDown?: (event: KeyboardEvent) => boolean | void;
  scrollRef?: React.Ref<HTMLDivElement | null>;
  id?: string;
  name?: string;
  'aria-label'?: string;
  'aria-invalid'?: boolean | 'true' | 'false';
  'data-testid'?: string;
};

const containerBaseClasses =
  'flex w-full min-h-16 rounded-lg border border-input bg-transparent px-2.5 py-2 text-base transition-colors outline-none focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40';

const disabledClasses =
  'cursor-not-allowed bg-input/50 opacity-50 dark:bg-input/80';

const proseClasses =
  'prose prose-sm dark:prose-invert max-w-none w-full flex-1 focus:outline-none [&_p]:my-0 [&_p+p]:mt-2 [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:mt-2 [&_h3]:mb-1 [&_ul]:my-1 [&_ol]:my-1 [&_blockquote]:my-1 [&_pre]:my-1';

const placeholderClasses =
  '[&_.is-editor-empty:first-child::before]:text-muted-foreground [&_.is-editor-empty:first-child::before]:content-[attr(data-placeholder)] [&_.is-editor-empty:first-child::before]:float-left [&_.is-editor-empty:first-child::before]:h-0 [&_.is-editor-empty:first-child::before]:pointer-events-none';

export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
  value,
  onValueChange,
  placeholder,
  disabled = false,
  className,
  autoFocus = false,
  onKeyDown,
  scrollRef,
  id,
  name,
  'aria-label': ariaLabel,
  'aria-invalid': ariaInvalid,
  'data-testid': dataTestId,
}) => {
  // useEditor captures props at init. Bag the live onKeyDown in a ref so the
  // handler reads the freshest callback without needing to recreate the editor.
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    autofocus: autoFocus,
    extensions: [
      StarterKit.configure({ hardBreak: false }),
      HardBreakAsNewline,
      Markdown.configure({
        html: false,
        linkify: true,
        breaks: true,
        transformPastedText: true,
        transformCopiedText: true,
      }),
      Placeholder.configure({
        placeholder: placeholder ?? '',
        emptyEditorClass: 'is-editor-empty',
      }),
    ],
    content: value,
    editorProps: {
      attributes: {
        ...(id ? { id } : {}),
        ...(ariaLabel ? { 'aria-label': ariaLabel } : {}),
        ...(name ? { 'data-name': name } : {}),
        class: cn(proseClasses, placeholderClasses),
      },
      handleKeyDown: (_view, event) => onKeyDownRef.current?.(event) === true,
      // Bulk inputs that carry embedded newlines (Playwright .fill, drag-drop
      // of multi-line text, programmatic execCommand('insertText', …)) would
      // otherwise split each line into a separate paragraph and shred
      // screenplay structure. Intercept beforeinput and convert single \n
      // into HardBreak nodes so the line layout survives the round-trip;
      // getMarkdown() then emits each as a single \n (with breaks:true).
      // Enter keypresses arrive as a separate inputType ('insertParagraph')
      // and aren't touched here, so typing a new paragraph still works.
      handleDOMEvents: {
        beforeinput: (view, event) => {
          if (!(event instanceof InputEvent)) return false;
          if (event.inputType !== 'insertText' || !event.data?.includes('\n')) {
            return false;
          }
          const { schema, tr, selection } = view.state;
          const hardBreak = schema.nodes.hardBreak;
          if (!hardBreak) return false;
          event.preventDefault();
          const parts = event.data.split('\n');
          const nodes = parts.flatMap((part, i) => {
            const out = [];
            if (part.length > 0) out.push(schema.text(part));
            if (i < parts.length - 1) out.push(hardBreak.create());
            return out;
          });
          view.dispatch(tr.replaceWith(selection.from, selection.to, nodes));
          return true;
        },
      },
      // Same treatment for actual paste events — markdown-it parses two
      // trailing spaces + \n as a hard break, so the pasted block stays in
      // one paragraph instead of splitting.
      transformPastedText: (text) => text.replace(/(?<!\n)\n(?!\n)/g, '  \n'),
    },
    onUpdate: ({ editor: e }) => {
      onValueChange(e.storage.markdown.getMarkdown());
    },
  });

  // Canonical Tiptap external-value sync (mirrors the Vue v-model example in
  // their docs): only setContent if the editor's current markdown differs
  // from the incoming value. The comparison itself is the guard — when our
  // onUpdate echoes the user's edit back into parent state, the round-trip
  // matches and this no-ops. emitUpdate:false prevents an onUpdate from
  // setContent retriggering this loop.
  //
  // Defer the write to the next frame so a burst of value changes (LLM
  // streaming the script chunk-by-chunk) collapses to one setContent with
  // the latest value. Each setContent is a full markdown re-parse + doc
  // rebuild and freezes the renderer if applied per-chunk at ~30Hz+.
  useEffect(() => {
    if (!editor) return;
    if (editor.storage.markdown.getMarkdown() === value) return;
    const rafId = requestAnimationFrame(() => {
      if (editor.storage.markdown.getMarkdown() === value) return;
      editor.commands.setContent(value, { emitUpdate: false });
    });
    return () => cancelAnimationFrame(rafId);
  }, [editor, value]);

  // editable is captured at init; mirror prop changes through to the editor.
  useEffect(() => {
    if (!editor) return;
    if (editor.isEditable === !disabled) return;
    editor.setEditable(!disabled);
  }, [editor, disabled]);

  return (
    <div
      ref={scrollRef}
      className={cn(
        containerBaseClasses,
        disabled && disabledClasses,
        'overflow-y-auto',
        className
      )}
      aria-invalid={ariaInvalid}
      data-testid={dataTestId}
      data-slot="markdown-editor"
    >
      <EditorContent editor={editor} className="w-full" />
    </div>
  );
};
