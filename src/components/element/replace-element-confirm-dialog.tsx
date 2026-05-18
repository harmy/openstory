import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Loader2 } from 'lucide-react';

type ReplaceElementConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  token: string;
  newFilename: string;
  affectedFrameCount: number;
  isLoading: boolean;
};

export const ReplaceElementConfirmDialog: React.FC<
  ReplaceElementConfirmDialogProps
> = ({
  open,
  onOpenChange,
  onConfirm,
  token,
  newFilename,
  affectedFrameCount,
  isLoading,
}) => {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Replace {token}?</AlertDialogTitle>
          <AlertDialogDescription>
            The new image{' '}
            <span className="font-mono text-foreground">{newFilename}</span>{' '}
            will replace the existing {token} reference.
          </AlertDialogDescription>
          {affectedFrameCount > 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              <strong>
                {affectedFrameCount} frame
                {affectedFrameCount !== 1 ? 's' : ''}
              </strong>{' '}
              referencing {token} will be edited to swap the element while
              keeping the rest of the frame intact.
            </p>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              No frames currently reference {token} — only the element image
              will change.
            </p>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isLoading}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm} disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Replacing…
              </>
            ) : (
              'Replace'
            )}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
};
