import { Button } from '@/components/ui/button';
import {
  useDeleteSequenceElement,
  useReplaceElementProgress,
} from '@/hooks/use-sequence-elements';
import type { SequenceElement } from '@/lib/db/schema';
import { Loader2, Pencil, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { RenameElementDialog } from './rename-element-dialog';
import { ReplaceElementPopover } from './replace-element-popover';

type ElementCardProps = {
  element: SequenceElement;
  sequenceId: string;
  affectedFrameCount: number;
  affectedVideoCount: number;
};

export const ElementCard: React.FC<ElementCardProps> = ({
  element,
  sequenceId,
  affectedFrameCount,
  affectedVideoCount,
}) => {
  const deleteMutation = useDeleteSequenceElement();
  const { editing: editingFrames } = useReplaceElementProgress(
    sequenceId,
    element.id,
    element.token
  );

  const [renameOpen, setRenameOpen] = useState(false);

  const isAnalyzing =
    element.visionStatus === 'pending' || element.visionStatus === 'analyzing';
  const isReplacing = editingFrames || isAnalyzing;
  const visionDone = element.visionStatus === 'completed';
  const visionFailed = element.visionStatus === 'failed';

  return (
    <>
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
        <div className="relative aspect-video overflow-hidden rounded-md bg-muted">
          {isReplacing ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 backdrop-blur-sm">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                {isAnalyzing ? 'Analyzing…' : 'Editing shots…'}
              </p>
            </div>
          ) : null}
          <img
            src={element.imageUrl}
            alt={element.uploadedFilename}
            className="size-full object-contain"
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <div className="flex flex-1 items-center gap-2 min-w-0">
            {visionDone ? (
              <>
                <span
                  className="flex-1 truncate rounded-md border border-input bg-background px-2 py-1 font-mono text-sm"
                  title={element.token}
                >
                  {element.token}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  disabled={isReplacing}
                  aria-label={`Rename ${element.token}`}
                  title="Rename"
                  onClick={() => setRenameOpen(true)}
                >
                  <Pencil className="size-4" />
                </Button>
              </>
            ) : (
              <span className="flex-1 inline-flex items-center gap-2 rounded-md border border-input bg-muted px-2 py-1 text-sm text-muted-foreground italic">
                {isAnalyzing ? (
                  <>
                    <Loader2 className="size-3 animate-spin" />
                    Naming…
                  </>
                ) : (
                  'Unnamed'
                )}
              </span>
            )}
          </div>
          <ReplaceElementPopover
            sequenceId={sequenceId}
            elementId={element.id}
            token={element.token}
            affectedFrameCount={affectedFrameCount}
            affectedVideoCount={affectedVideoCount}
            disabled={isReplacing}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={deleteMutation.isPending || isReplacing}
            aria-label={`Delete ${element.token}`}
            onClick={() =>
              deleteMutation.mutate({
                elementId: element.id,
                sequenceId,
              })
            }
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          {isAnalyzing ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" />
              Analyzing image…
            </span>
          ) : visionFailed ? (
            <span className="text-destructive">
              Vision failed: {element.visionError ?? 'unknown error'}
            </span>
          ) : (
            <span>{element.description ?? 'No description'}</span>
          )}
        </div>
        {affectedFrameCount > 0 ? (
          <p className="text-xs text-muted-foreground/70">
            Used in {affectedFrameCount} shot
            {affectedFrameCount === 1 ? '' : 's'}
            {affectedVideoCount > 0
              ? ` (${affectedVideoCount} with video)`
              : ''}
          </p>
        ) : null}
      </div>

      {visionDone && (
        <RenameElementDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          sequenceId={sequenceId}
          elementId={element.id}
          currentToken={element.token}
          affectedFrameCount={affectedFrameCount}
        />
      )}
    </>
  );
};
