import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  listShotPromptVariantsFn,
  listSequenceMusicPromptVariantsFn,
  restoreShotPromptVariantFn,
  restoreSequenceMusicPromptVariantFn,
} from '@/functions/prompt-variants';
import { shotKeys } from '@/hooks/use-shots';
import { sequenceKeys } from '@/hooks/use-sequences';
import type { PromptVariantSource } from '@/lib/db/schema';
import { cn } from '@/lib/utils';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { PromptDiffView } from './prompt-diff-view';

type PromptHistoryMode = 'visual' | 'motion' | 'music';

type SharedProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type ShotProps = SharedProps & {
  mode: 'visual' | 'motion';
  sequenceId: string;
  shotId: string;
  /** Current cached prompt — diff target. */
  currentText: string;
};

type MusicProps = SharedProps & {
  mode: 'music';
  sequenceId: string;
  /** Current cached music prompt — diff target. */
  currentText: string;
};

export type PromptHistorySheetProps = ShotProps | MusicProps;

const SOURCE_LABEL: Record<PromptVariantSource, string> = {
  'ai-generated': 'AI',
  'user-edit': 'You',
  regenerated: 'Regenerated',
  restored: 'Restored',
};

const SOURCE_VARIANT: Record<
  PromptVariantSource,
  'default' | 'secondary' | 'outline'
> = {
  'ai-generated': 'secondary',
  'user-edit': 'default',
  regenerated: 'outline',
  restored: 'outline',
};

const TITLE: Record<PromptHistoryMode, string> = {
  visual: 'Visual prompt history',
  motion: 'Motion prompt history',
  music: 'Music prompt history',
};

type Row = {
  id: string;
  source: PromptVariantSource;
  text: string;
  createdAt: Date;
  createdByName: string | null;
  inputHash: string | null;
};

function formatTimestamp(d: Date): string {
  return d.toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export const PromptHistorySheet: React.FC<PromptHistorySheetProps> = (
  props
) => {
  const { open, onOpenChange, mode, currentText, sequenceId } = props;
  const shotId = props.mode === 'music' ? null : props.shotId;
  const queryClient = useQueryClient();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const queryKey =
    mode === 'music'
      ? (['prompt-variants', 'music', sequenceId] as const)
      : (['prompt-variants', mode, shotId] as const);

  const {
    data: rows,
    isLoading,
    error,
    refetch,
  } = useQuery<Row[]>({
    queryKey,
    queryFn: async () => {
      if (mode === 'music') {
        const variants = await listSequenceMusicPromptVariantsFn({
          data: { sequenceId },
        });
        return variants.map((v) => ({
          id: v.id,
          source: v.source,
          text: v.prompt,
          createdAt: v.createdAt,
          createdByName: v.createdByName,
          inputHash: v.inputHash,
        }));
      }
      if (!shotId) return [];
      const variants = await listShotPromptVariantsFn({
        data: { sequenceId, shotId: shotId, promptType: mode },
      });
      return variants.map((v) => ({
        id: v.id,
        source: v.source,
        text: v.text,
        createdAt: v.createdAt,
        createdByName: v.createdByName,
        inputHash: v.inputHash,
      }));
    },
    enabled: open,
    staleTime: 5_000,
  });

  const restoreMutation = useMutation({
    mutationFn: async (variantId: string) => {
      if (mode === 'music') {
        return await restoreSequenceMusicPromptVariantFn({
          data: { sequenceId, variantId },
        });
      }
      if (!shotId) throw new Error('shotId required');
      return await restoreShotPromptVariantFn({
        data: { sequenceId, shotId: shotId, variantId },
      });
    },
    onSuccess: async () => {
      toast.success('Prompt restored');
      await queryClient.invalidateQueries({ queryKey });
      if (mode === 'music') {
        await queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequenceId),
        });
      } else if (shotId) {
        await queryClient.invalidateQueries({
          queryKey: shotKeys.detail(shotId),
        });
        await queryClient.invalidateQueries({
          queryKey: shotKeys.list(sequenceId),
        });
      }
    },
    onError: (error) => {
      toast.error('Restore failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    },
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 sm:max-w-md"
      >
        <SheetHeader>
          <SheetTitle>{TITLE[mode]}</SheetTitle>
          <SheetDescription>
            Append-only history. Restore writes a new entry without deleting
            anything.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="flex-1 px-4 pb-4">
          {isLoading ? (
            <div className="flex flex-col gap-2 pt-2">
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
              <Skeleton className="h-20 w-full" />
            </div>
          ) : error ? (
            // Distinguish "couldn't load" from "no history" — falling through
            // to the empty state would invite the user to overwrite history
            // they actually still have.
            <Alert variant="destructive" className="mt-2">
              <AlertCircle aria-hidden="true" />
              <AlertTitle>Couldn't load history</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <span>
                  {error instanceof Error ? error.message : 'Unknown error'}
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void refetch()}
                  className="self-start"
                >
                  Retry
                </Button>
              </AlertDescription>
            </Alert>
          ) : !rows || rows.length === 0 ? (
            <p className="pt-4 text-sm text-muted-foreground">
              No history yet — generate or edit a prompt to start a record.
            </p>
          ) : (
            <ul className="flex flex-col gap-2 pt-2">
              {rows.map((row) => {
                const expanded = expandedId === row.id;
                const isCurrent = row.text === currentText;
                const panelId = `prompt-history-panel-${row.id}`;
                const triggerId = `prompt-history-trigger-${row.id}`;
                return (
                  <li
                    key={row.id}
                    className={cn(
                      'flex flex-col gap-2 rounded-md border p-3 transition-colors',
                      isCurrent && 'border-primary/40 bg-primary/5'
                    )}
                  >
                    <button
                      id={triggerId}
                      type="button"
                      onClick={() => setExpandedId(expanded ? null : row.id)}
                      aria-expanded={expanded}
                      aria-controls={panelId}
                      className={cn(
                        'flex w-full flex-col gap-2 rounded-sm text-left transition-colors',
                        'hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50'
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Badge variant={SOURCE_VARIANT[row.source]}>
                            {SOURCE_LABEL[row.source]}
                          </Badge>
                          {isCurrent && (
                            <Badge variant="outline">Current</Badge>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground tabular-nums">
                          {formatTimestamp(row.createdAt)}
                        </span>
                      </div>
                      {row.createdByName && (
                        <span className="text-xs text-muted-foreground">
                          by {row.createdByName}
                        </span>
                      )}
                      {!expanded && (
                        <p className="line-clamp-2 text-sm text-muted-foreground">
                          {row.text}
                        </p>
                      )}
                    </button>
                    {expanded && (
                      <section
                        id={panelId}
                        aria-labelledby={triggerId}
                        className="flex flex-col gap-2"
                      >
                        <PromptDiffView before={currentText} after={row.text} />
                        {!isCurrent && (
                          <div className="flex justify-end">
                            <Button
                              type="button"
                              size="sm"
                              disabled={restoreMutation.isPending}
                              onClick={() => restoreMutation.mutate(row.id)}
                            >
                              {restoreMutation.isPending && (
                                <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                              )}
                              Restore this version
                            </Button>
                          </div>
                        )}
                      </section>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
};
