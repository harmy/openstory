import type React from 'react';
import { useMemo, useState } from 'react';
import { Image } from '@unpic/react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EvalSceneCell } from './eval-scene-cell';
import type { DialogTab } from './eval-cell-dialog';
import type { SequenceWithFrames } from '@/hooks/use-sequences-with-frames';
import type { ViewMode } from './eval-view';
import { getAspectRatioData } from '@/lib/constants/aspect-ratios';
import { getAnalysisModelById } from '@/lib/ai/models.config';
import { Route as sequencesScenesRoute } from '@/routes/_protected/sequences/$id/scenes';
import { Link } from '@tanstack/react-router';
import { ChevronRight, Mail, User } from 'lucide-react';
import { getCreatorIdentity } from './creator-identity';

// Strip cell height in px. Widths follow each sequence's aspect ratio so the
// strip stays visually coherent inside one row.
const STRIP_HEIGHT = 180;

type OpenDialogState = {
  sequenceIndex: number;
  sceneIndex: number;
  initialTab?: DialogTab;
} | null;

type EvalSequencesMobileProps = {
  sequences: SequenceWithFrames[];
  viewMode: ViewMode;
  framesLoadingMap: Record<string, boolean>;
  divergenceMap?: Map<string, { hasVideo: boolean; hasMusic: boolean }>;
  onLoadMore?: () => void;
  hasMore?: boolean;
};

export const EvalSequencesMobile: React.FC<EvalSequencesMobileProps> = ({
  sequences,
  viewMode,
  framesLoadingMap,
  divergenceMap,
  onLoadMore,
  hasMore,
}) => {
  const [openDialog, setOpenDialog] = useState<OpenDialogState>(null);

  const maxSceneCount = useMemo(
    () => Math.max(1, ...sequences.map((s) => s.frames.length)),
    [sequences]
  );

  const handleNavigateToCell = (sequenceIndex: number, sceneIndex: number) => {
    if (
      sequenceIndex >= 0 &&
      sequenceIndex < sequences.length &&
      sceneIndex >= 0 &&
      sceneIndex < maxSceneCount
    ) {
      setOpenDialog({ sequenceIndex, sceneIndex });
    }
  };

  return (
    <div className="flex-1 overflow-y-auto flex flex-col divide-y divide-border">
      {sequences.map((sequence, sequenceIndex) => (
        <MobileReelRow
          key={sequence.id}
          sequence={sequence}
          sequenceIndex={sequenceIndex}
          sequenceCount={sequences.length}
          viewMode={viewMode}
          framesLoading={framesLoadingMap[sequence.id] ?? false}
          divergence={divergenceMap?.get(sequence.id)}
          openDialog={openDialog}
          onOpenDialogChange={setOpenDialog}
          onNavigateToCell={handleNavigateToCell}
        />
      ))}
      {hasMore && onLoadMore && (
        <div className="flex justify-center p-4">
          <Button variant="outline" size="sm" onClick={onLoadMore}>
            Load more
          </Button>
        </div>
      )}
    </div>
  );
};

type MobileReelRowProps = {
  sequence: SequenceWithFrames;
  sequenceIndex: number;
  sequenceCount: number;
  viewMode: ViewMode;
  framesLoading: boolean;
  divergence?: { hasVideo: boolean; hasMusic: boolean };
  openDialog: OpenDialogState;
  onOpenDialogChange: (state: OpenDialogState) => void;
  onNavigateToCell: (sequenceIndex: number, sceneIndex: number) => void;
};

const MobileReelRow: React.FC<MobileReelRowProps> = ({
  sequence,
  sequenceIndex,
  sequenceCount,
  viewMode,
  framesLoading,
  divergence,
  openDialog,
  onOpenDialogChange,
  onNavigateToCell,
}) => {
  const aspectRatio = sequence.aspectRatio;
  const ratioData = getAspectRatioData(aspectRatio);
  const cellWidth = ratioData
    ? (STRIP_HEIGHT * ratioData.width) / ratioData.height
    : STRIP_HEIGHT;
  const frameCount = sequence.frames.length;
  const hasVariants = Boolean(divergence?.hasVideo || divergence?.hasMusic);

  return (
    <div className="flex flex-col gap-2 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <Link
            to={sequencesScenesRoute.fullPath}
            params={{ id: sequence.id }}
            className="font-medium text-sm text-foreground line-clamp-1 hover:underline"
            title={sequence.title || 'Untitled Sequence'}
          >
            {sequence.title || 'Untitled Sequence'}
          </Link>
          <CreatorIdentity sequence={sequence} />
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {hasVariants && (
            <span
              aria-label="Variants available — open to compare"
              title="Variants available — open to compare"
              className="inline-flex h-2 w-2 rounded-full bg-sky-500 ring-2 ring-sky-500/30"
            />
          )}
          <Button
            asChild
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            aria-label="Open sequence"
          >
            <Link
              to={sequencesScenesRoute.fullPath}
              params={{ id: sequence.id }}
            >
              <ChevronRight className="h-4 w-4" />
            </Link>
          </Button>
        </div>
      </div>

      <div className="-mx-3 overflow-x-auto [mask-image:linear-gradient(to_right,black,black_calc(100%-12px),transparent)]">
        <div
          className="flex gap-2 pl-3"
          style={{ height: STRIP_HEIGHT, minWidth: 'min-content' }}
        >
          <MergedVideoCell
            sequence={sequence}
            width={cellWidth}
            height={STRIP_HEIGHT}
          />
          {frameCount === 0 ? (
            framesLoading ? (
              <Skeleton
                style={{ width: cellWidth, height: STRIP_HEIGHT }}
                className="shrink-0"
              />
            ) : (
              <div
                className="shrink-0 border-2 border-dashed border-muted rounded-md flex items-center justify-center text-xs text-muted-foreground"
                style={{ width: cellWidth, height: STRIP_HEIGHT }}
              >
                No scenes yet
              </div>
            )
          ) : (
            sequence.frames.map((frame, sceneIndex) => {
              const isDialogOpen =
                openDialog?.sequenceIndex === sequenceIndex &&
                openDialog.sceneIndex === sceneIndex;
              const dialogInitialTab = isDialogOpen
                ? openDialog.initialTab
                : undefined;

              return (
                <div
                  key={frame.id}
                  className="shrink-0 border rounded-md overflow-hidden bg-card [&>button]:!border-b-0 [&>div]:!border-b-0"
                  style={{ width: cellWidth, height: STRIP_HEIGHT }}
                >
                  <EvalSceneCell
                    frame={frame}
                    viewMode={viewMode}
                    sceneNumber={sceneIndex + 1}
                    sequenceTitle={sequence.title}
                    aspectRatio={aspectRatio}
                    framesLoading={framesLoading}
                    dialogOpen={isDialogOpen}
                    dialogInitialTab={dialogInitialTab}
                    onDialogOpenChange={(open) => {
                      onOpenDialogChange(
                        open ? { sequenceIndex, sceneIndex } : null
                      );
                    }}
                    onNavigateLeft={() => {
                      if (sceneIndex > 0) {
                        onNavigateToCell(sequenceIndex, sceneIndex - 1);
                      }
                    }}
                    onNavigateRight={() => {
                      if (sceneIndex < frameCount - 1) {
                        onNavigateToCell(sequenceIndex, sceneIndex + 1);
                      }
                    }}
                    onNavigateUp={() => {
                      if (sequenceIndex > 0) {
                        onNavigateToCell(sequenceIndex - 1, sceneIndex);
                      }
                    }}
                    onNavigateDown={() => {
                      if (sequenceIndex < sequenceCount - 1) {
                        onNavigateToCell(sequenceIndex + 1, sceneIndex);
                      }
                    }}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};

const CreatorIdentity: React.FC<{ sequence: SequenceWithFrames }> = ({
  sequence,
}) => {
  const { name, email } = getCreatorIdentity(sequence);
  if (!name && !email) return null;

  return (
    <div className="mt-0.5 flex items-center gap-1 text-xs text-muted-foreground">
      {name ? (
        <User className="h-3 w-3 shrink-0" />
      ) : (
        <Mail className="h-3 w-3 shrink-0" />
      )}
      <span className="truncate">{name ?? email}</span>
    </div>
  );
};

type MergedVideoCellProps = {
  sequence: SequenceWithFrames;
  width: number;
  height: number;
};

const MergedVideoCell: React.FC<MergedVideoCellProps> = ({
  sequence,
  width,
  height,
}) => {
  const baseClass =
    'shrink-0 border rounded-md overflow-hidden bg-card relative flex items-center justify-center';
  const style = { width, height };

  const analysisModelName =
    getAnalysisModelById(sequence.analysisModel)?.name ??
    sequence.analysisModel;

  const modelBadge = (
    <span className="absolute top-1 right-1 z-[1] inline-flex items-center text-[10px] leading-none text-foreground/90 bg-background/80 backdrop-blur-sm px-1.5 py-0.5 rounded-sm border border-border/40 pointer-events-none max-w-[calc(100%-0.5rem)] truncate">
      {analysisModelName}
    </span>
  );

  const linkProps = {
    to: sequencesScenesRoute.fullPath,
    params: { id: sequence.id },
    'aria-label': `Open ${sequence.title || 'sequence'}`,
  } as const;

  if (sequence.posterUrl) {
    return (
      <Link {...linkProps} className={baseClass} style={style}>
        <Image
          src={sequence.posterUrl}
          alt={`${sequence.title || 'Sequence'} poster`}
          className="w-full h-full object-cover"
          loading="lazy"
          width={1000}
          height={1000}
        />
        {modelBadge}
      </Link>
    );
  }

  return (
    <Link
      {...linkProps}
      className={`${baseClass} border-dashed text-xs text-muted-foreground`}
      style={style}
    >
      No preview yet
      {modelBadge}
    </Link>
  );
};
