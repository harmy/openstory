import { Placeholder } from '@tiptap/extensions/placeholder';
import { EditorContent, useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown, type MarkdownStorage } from 'tiptap-markdown';
import { cn } from '@/lib/utils';
import * as React from 'react';
import { useEffect, useRef } from 'react';

declare module '@tiptap/core' {
  interface Storage {
    markdown: MarkdownStorage;
  }
}

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
  const isInternalUpdateRef = useRef(false);
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;

  const editor = useEditor({
    immediatelyRender: false,
    editable: !disabled,
    autofocus: autoFocus,
    extensions: [
      StarterKit,
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
      handleKeyDown: (_view, event) => {
        const result = onKeyDownRef.current?.(event);
        return result === true;
      },
    },
    onUpdate: ({ editor: e }) => {
      const markdown = e.storage.markdown.getMarkdown() as string;
      isInternalUpdateRef.current = true;
      onValueChange(markdown);
    },
  });

  // External value sync (e.g. AI enhance, form reset). Skip when the update
  // originated from the editor itself to avoid an infinite loop / cursor jump.
  useEffect(() => {
    if (!editor) return;
    if (isInternalUpdateRef.current) {
      isInternalUpdateRef.current = false;
      return;
    }
    const current = editor.storage.markdown.getMarkdown() as string;
    if (current === value) return;
    editor.commands.setContent(value, { emitUpdate: false });
  }, [editor, value]);

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
