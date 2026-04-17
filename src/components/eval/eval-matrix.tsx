import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Card } from '@/components/ui/card';
import { EvalSequenceRow } from './eval-sequence-row';
import type { SequenceWithFrames } from '@/hooks/use-sequences-with-frames';
import type { ViewMode } from './eval-view';

const ROW_HEIGHT = 240;
const METADATA_WIDTH = 280;
const VIDEO_WIDTH = 200;
const CELL_WIDTH = 200;

type EvalMatrixProps = {
  sequences: SequenceWithFrames[];
  viewMode: ViewMode;
  onLoadMore?: () => void;
  hasMore?: boolean;
};

type OpenDialogState = {
  sequenceIndex: number;
  sceneIndex: number;
} | null;

export const EvalMatrix: React.FC<EvalMatrixProps> = ({
  sequences,
  viewMode,
  onLoadMore,
  hasMore,
}) => {
  const parentRef = useRef<HTMLDivElement>(null);
  const [openDialog, setOpenDialog] = useState<OpenDialogState>(null);

  // Calculate max scene count across all sequences
  const maxSceneCount = useMemo(() => {
    return Math.max(1, ...sequences.map((s) => s.frames.length));
  }, [sequences]);

  const rowVirtualizer = useVirtualizer({
    count: sequences.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 5,
  });

  // Infinite scroll: fetch next page when last items are visible
  const virtualItems = rowVirtualizer.getVirtualItems();
  const lastItemIndex = virtualItems[virtualItems.length - 1]?.index;
  useEffect(() => {
    if (!onLoadMore || !hasMore) return;
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- lastItemIndex can be undefined when virtualItems is empty
    if (lastItemIndex == null || lastItemIndex >= sequences.length - 5) {
      onLoadMore();
    }
  }, [lastItemIndex, sequences.length, onLoadMore, hasMore]);

  const totalWidth = METADATA_WIDTH + VIDEO_WIDTH + maxSceneCount * CELL_WIDTH;

  const handleNavigateToCell = (sequenceIndex: number, sceneIndex: number) => {
    // Validate bounds and check if frame exists
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
    <Card className="flex-1 overflow-hidden">
      <div ref={parentRef} className="overflow-auto h-full">
        {/* Sticky header row */}
        <div
          className="sticky top-0 z-20 flex bg-background border-b"
          style={{ width: totalWidth }}
        >
          <div
            className="sticky left-0 z-30 bg-background border-r p-4 font-medium text-sm shrink-0"
            style={{ width: METADATA_WIDTH }}
          >
            Sequence
          </div>
          <div
            className="sticky z-20 bg-background border-r p-4 font-medium text-sm shrink-0"
            style={{ left: METADATA_WIDTH, width: VIDEO_WIDTH }}
          >
            Video
          </div>
          {Array.from({ length: maxSceneCount }, (_, idx) => idx + 1).map(
            (sceneNum) => (
              <div
                key={`header-${sceneNum}`}
                className="p-4 text-center font-medium text-sm shrink-0"
                style={{ width: CELL_WIDTH }}
              >
                Scene {sceneNum}
              </div>
            )
          )}
        </div>

        {/* Virtualized rows */}
        <div
          style={{
            height: rowVirtualizer.getTotalSize(),
            width: totalWidth,
            position: 'relative',
          }}
        >
          {rowVirtualizer.getVirtualItems().map((virtualRow) => {
            const sequence = sequences[virtualRow.index];
            return (
              <div
                key={sequence.id}
                className="absolute left-0 flex items-stretch"
                style={{
                  top: 0,
                  transform: `translateY(${virtualRow.start}px)`,
                  height: virtualRow.size,
                  width: totalWidth,
                }}
              >
                <EvalSequenceRow
                  sequence={sequence}
                  viewMode={viewMode}
                  maxSceneCount={maxSceneCount}
                  sequenceIndex={virtualRow.index}
                  openDialog={openDialog}
                  onOpenDialogChange={setOpenDialog}
                  onNavigateToCell={handleNavigateToCell}
                />
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
};
