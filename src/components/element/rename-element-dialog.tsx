import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useRenameSequenceElementToken } from '@/hooks/use-sequence-elements';
import { deriveTokenFromFilename } from '@/lib/sequence-elements/derive-token';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

type RenameElementDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sequenceId: string;
  elementId: string;
  currentToken: string;
  affectedShotCount: number;
};

export const RenameElementDialog: React.FC<RenameElementDialogProps> = ({
  open,
  onOpenChange,
  sequenceId,
  elementId,
  currentToken,
  affectedShotCount,
}) => {
  const renameMutation = useRenameSequenceElementToken();
  const [value, setValue] = useState(currentToken);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setValue(currentToken);
      setError(null);
      // Focus on open; deferred so the dialog's mount-time focus trap
      // doesn't immediately steal it back.
      const t = window.setTimeout(() => {
        inputRef.current?.select();
        inputRef.current?.focus();
      }, 0);
      return () => window.clearTimeout(t);
    }
  }, [open, currentToken]);

  const normalized = deriveTokenFromFilename(value);
  const isUnchanged = normalized === currentToken;

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (isUnchanged) {
      onOpenChange(false);
      return;
    }
    setError(null);
    renameMutation.mutate(
      { sequenceId, elementId, token: normalized },
      {
        onSuccess: (result) => {
          onOpenChange(false);
          const updates: string[] = [];
          if (result.scriptUpdated) updates.push('script');
          if (result.shotsUpdated > 0) {
            updates.push(
              `${result.shotsUpdated} shot${result.shotsUpdated === 1 ? '' : 's'}`
            );
          }
          const suffix =
            updates.length > 0 ? ` — updated ${updates.join(' + ')}` : '';
          toast.success(`Renamed to ${normalized}${suffix}`);
        },
        onError: (err) => {
          const message =
            err instanceof Error ? err.message : 'Failed to rename element';
          setError(message);
        },
      }
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Rename element</DialogTitle>
            <DialogDescription>
              {affectedShotCount > 0
                ? `${currentToken} is used in ${affectedShotCount} shot${
                    affectedShotCount === 1 ? '' : 's'
                  }. Renaming will rewrite every reference in your script and shots.`
                : 'Renaming will rewrite every reference in your script and shots.'}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2 py-4">
            <Input
              ref={inputRef}
              value={value}
              onChange={(e) => {
                setValue(e.currentTarget.value);
                if (error) setError(null);
              }}
              placeholder="ELEMENT_NAME"
              className="font-mono"
              aria-invalid={!!error}
              aria-describedby={error ? 'rename-error' : 'rename-hint'}
            />
            <p id="rename-hint" className="text-xs text-muted-foreground">
              Saved as <span className="font-mono">{normalized}</span>
            </p>
            {error && (
              <p
                id="rename-error"
                className="text-xs text-destructive"
                role="alert"
              >
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
              disabled={renameMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={renameMutation.isPending || isUnchanged}
            >
              {renameMutation.isPending ? 'Renaming…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
};
