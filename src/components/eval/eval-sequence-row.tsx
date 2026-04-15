import type React from 'react';
import { EvalSequenceMetadata } from './eval-sequence-metadata';
import { EvalSceneCell } from './eval-scene-cell';
import type { SequenceWithFrames } from '@/hooks/use-sequences-with-frames';
import type { ViewMode } from './eval-view';

const METADATA_WIDTH = 280;
const VIDEO_WIDTH = 200;
const CELL_WIDTH = 200;

type OpenDialogState = {
  sequenceIndex: number;
  sceneIndex: number;
} | null;

type EvalSequenceRowProps = {
  sequence: SequenceWithFrames;
  viewMode: ViewMode;
  maxSceneCount: number;
  sequenceIndex: number;
  openDialog: OpenDialogState;
  onOpenDialogChange: (state: OpenDialogState) => void;
  onNavigateToCell: (sequenceIndex: number, sceneIndex: number) => void;
};

export const EvalSequenceRow: React.FC<EvalSequenceRowProps> = ({
  sequence,
  viewMode,
  maxSceneCount,
  sequenceIndex,
  openDialog,
  onOpenDialogChange,
  onNavigateToCell,
}) => {
  return (
    <>
      <div
        className="sticky left-0 z-10 bg-background shrink-0 h-full"
        style={{ width: METADATA_WIDTH }}
      >
        <EvalSequenceMetadata sequence={sequence} />
      </div>
      <div
        className="sticky z-10 bg-background shrink-0 h-full border-r border-b p-2 flex items-center justify-center"
        style={{ left: METADATA_WIDTH, width: VIDEO_WIDTH }}
      >
        {sequence.mergedVideoUrl ? (
          <video
            src={sequence.mergedVideoUrl}
            className="w-full h-full object-contain rounded-md"
            muted
            loop
            playsInline
            controls
          />
        ) : (
          <div className="text-xs text-muted-foreground text-center">
            No video
          </div>
        )}
      </div>
      {Array.from({ length: maxSceneCount }, (_, i) => {
        const frame = sequence.frames[i];
        const sceneIndex = i;
        const isDialogOpen =
          openDialog?.sequenceIndex === sequenceIndex &&
          openDialog.sceneIndex === sceneIndex;

        return (
          <div
            key={frame.id}
            className="shrink-0 h-full"
            style={{ width: CELL_WIDTH }}
          >
            <EvalSceneCell
              frame={frame}
              viewMode={viewMode}
              sceneNumber={i + 1}
              sequenceTitle={sequence.title}
              dialogOpen={isDialogOpen}
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
