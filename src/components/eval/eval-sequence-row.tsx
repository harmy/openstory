import type React from 'react';
import { Image } from '@unpic/react';
import { EvalSequenceMetadata } from './eval-sequence-metadata';
import { EvalSceneCell } from './eval-scene-cell';
import type { DialogTab } from './eval-cell-dialog';
import type { SequenceWithFrames } from '@/hooks/use-sequences-with-frames';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import type { ViewMode } from './eval-view';

const METADATA_WIDTH = 280;
const VIDEO_WIDTH = 400;
const CELL_WIDTH = 200;

type OpenDialogState = {
  sequenceIndex: number;
  sceneIndex: number;
  initialTab?: DialogTab;
} | null;

type EvalSequenceRowProps = {
  sequence: SequenceWithFrames;
  viewMode: ViewMode;
  maxSceneCount: number;
  sequenceIndex: number;
  framesLoading: boolean;
  divergence?: { hasVideo: boolean; hasMusic: boolean };
  openDialog: OpenDialogState;
  onOpenDialogChange: (state: OpenDialogState) => void;
  onNavigateToCell: (sequenceIndex: number, sceneIndex: number) => void;
  onOpenTheatre: (sequenceIndex: number) => void;
};

export const EvalSequenceRow: React.FC<EvalSequenceRowProps> = ({
  sequence,
  viewMode,
  maxSceneCount,
  sequenceIndex,
  framesLoading,
  divergence,
  openDialog,
  onOpenDialogChange,
  onNavigateToCell,
  onOpenTheatre,
}) => {
  const aspectRatio: AspectRatio =
    (sequence.aspectRatio as AspectRatio | null) ?? DEFAULT_ASPECT_RATIO;

  return (
    <>
      <div
        className="sticky left-0 z-10 bg-background shrink-0 h-full"
        style={{ width: METADATA_WIDTH }}
      >
        <EvalSequenceMetadata sequence={sequence} divergence={divergence} />
      </div>
      <div
        className="sticky z-10 bg-background shrink-0 h-full border-r border-b p-2 flex items-center justify-center"
        style={{ left: METADATA_WIDTH, width: VIDEO_WIDTH }}
      >
        {sequence.posterUrl ? (
          <button
            type="button"
            onClick={() => onOpenTheatre(sequenceIndex)}
            aria-label={`Play ${sequence.title || 'sequence'} in theatre`}
            className="w-full h-full flex items-center justify-center cursor-pointer appearance-none bg-transparent border-0 p-0"
          >
            <Image
              src={sequence.posterUrl}
              alt={`${sequence.title || 'Sequence'} preview`}
              className="max-w-full max-h-full object-contain rounded-md"
              loading="lazy"
              width={1000}
              height={1000}
            />
          </button>
        ) : (
          <div className="text-xs text-muted-foreground text-center">
            No preview
          </div>
        )}
      </div>
      {Array.from({ length: maxSceneCount }, (_, i) => {
        const frame = sequence.frames[i];
        const sceneIndex = i;
        const isDialogOpen =
          openDialog?.sequenceIndex === sequenceIndex &&
          openDialog.sceneIndex === sceneIndex;
        const dialogInitialTab = isDialogOpen
          ? openDialog.initialTab
          : undefined;

        return (
          <div
            // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- frame is undefined when sequence has fewer frames than maxSceneCount
            key={frame?.id ?? `empty-${i}`}
            className="shrink-0 h-full"
            style={{ width: CELL_WIDTH }}
          >
            <EvalSceneCell
              frame={frame}
              viewMode={viewMode}
              sceneNumber={i + 1}
              sequenceTitle={sequence.title}
              aspectRatio={aspectRatio}
              framesLoading={framesLoading}
              dialogOpen={isDialogOpen}
              dialogInitialTab={dialogInitialTab}
              onDialogOpenChange={(open) => {
                if (open) {
                  onOpenDialogChange({ sequenceIndex, sceneIndex });
                } else {
                  onOpenDialogChange(null);
                }
              }}
              onNavigateLeft={() => {
                if (sceneIndex > 0) {
                  onNavigateToCell(sequenceIndex, sceneIndex - 1);
                }
              }}
              onNavigateRight={() => {
                if (sceneIndex < maxSceneCount - 1) {
                  onNavigateToCell(sequenceIndex, sceneIndex + 1);
                }
              }}
              onNavigateUp={() => {
                if (sequenceIndex > 0) {
                  onNavigateToCell(sequenceIndex - 1, sceneIndex);
                }
              }}
              onNavigateDown={() => {
                onNavigateToCell(sequenceIndex + 1, sceneIndex);
              }}
            />
          </div>
        );
      })}
    </>
  );
};
