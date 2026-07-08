import { Skeleton } from '@/components/ui/skeleton';
import type { Style } from '@/lib/db/schema/libraries';
import { cn } from '@/lib/utils';
import { AppImage } from '@/components/ui/app-image';
import { MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StyleRecommendation } from '@/hooks/use-styles';
import {
  buildRecommendationReasoningMap,
  prioritizeRecommendedStyles,
  RECOMMENDED_STYLE_SLOT_COUNT,
} from '@/lib/style/prioritize-recommended-styles';
import { getStyleGradient } from './style-gradient';
import { StyleSelectionDialog } from './style-selection-dialog';

const StyleTileBackground: React.FC<{ style: Style }> = ({ style }) => {
  const [imgError, setImgError] = useState(false);

  return style.previewUrl && !imgError ? (
    <AppImage
      key={style.id}
      src={style.previewUrl}
      layout="fullWidth"
      alt={style.name}
      className="h-full w-full object-cover"
      onError={() => setImgError(true)}
    />
  ) : (
    <div
      className="h-full w-full"
      style={{
        background: getStyleGradient(style.config.colorPalette),
      }}
    />
  );
};

type StyleSelectorProps = {
  styles: Style[];
  selectedStyleId: string | null;
  onStyleSelect: (styleId: string) => void;
  loading?: boolean;
  disabled?: boolean;
  /** Ranked picks replace the first slots in the inline grid and dialog. */
  recommendations?: StyleRecommendation[];
  /** Recommendation ranking is in flight (skeletons in the first slots). */
  recommendationsLoading?: boolean;
};

export function StyleSelector({
  styles,
  selectedStyleId,
  onStyleSelect,
  loading = false,
  disabled = false,
  recommendations,
  recommendationsLoading = false,
}: StyleSelectorProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusableIndex, setFocusableIndex] = useState(0);
  const [visibleCount, setVisibleCount] = useState(10);

  // Always reserve the last slot for "View all".
  const reservedSlots = 1;

  useEffect(() => {
    const container = gridRef.current;
    if (!container) return;

    const calculateColumns = (width: number) => {
      const tileSize = 65;
      const gap = 12;
      const columns = Math.floor((width + gap) / (tileSize + gap));
      setVisibleCount(Math.max(3, columns));
    };

    calculateColumns(container.clientWidth);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      calculateColumns(entry.contentRect.width);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const reasoningByStyleId = useMemo(
    () => buildRecommendationReasoningMap(recommendations),
    [recommendations]
  );

  const displayStyles = useMemo(
    () =>
      prioritizeRecommendedStyles(
        styles,
        recommendations,
        RECOMMENDED_STYLE_SLOT_COUNT,
        selectedStyleId
      ),
    [styles, recommendations, selectedStyleId]
  );

  const maxStyleSlots = Math.max(0, visibleCount - reservedSlots);
  const showRecommendationSkeletons =
    recommendationsLoading && (recommendations?.length ?? 0) === 0;
  const recommendationSkeletonCount = showRecommendationSkeletons
    ? Math.min(RECOMMENDED_STYLE_SLOT_COUNT, maxStyleSlots)
    : 0;

  const fillerStyles = useMemo(
    () => prioritizeRecommendedStyles(styles, undefined, 0, selectedStyleId),
    [styles, selectedStyleId]
  );

  const visibleStyles = showRecommendationSkeletons
    ? fillerStyles.slice(0, maxStyleSlots - recommendationSkeletonCount)
    : displayStyles.slice(0, maxStyleSlots);
  const hiddenCount = Math.max(0, styles.length - visibleStyles.length);
  const styleTileCount = recommendationSkeletonCount + visibleStyles.length;
  const moreIndex = styleTileCount;
  const totalItems = moreIndex + 1;

  useEffect(() => {
    if (visibleStyles.length === 0 && recommendationSkeletonCount === 0) return;

    const selectedIndex = visibleStyles.findIndex(
      (s) => s.id === selectedStyleId
    );
    if (selectedIndex !== -1) {
      setFocusableIndex(recommendationSkeletonCount + selectedIndex);
    } else {
      setFocusableIndex(0);
    }
  }, [selectedStyleId, visibleStyles, recommendationSkeletonCount]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent, currentIndex: number) => {
      let nextIndex = currentIndex;

      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          nextIndex = Math.min(currentIndex + 1, totalItems - 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          nextIndex = Math.max(currentIndex - 1, 0);
          break;
        case 'Home':
          event.preventDefault();
          nextIndex = 0;
          break;
        case 'End':
          event.preventDefault();
          nextIndex = totalItems - 1;
          break;
        default:
          return;
      }

      if (nextIndex !== currentIndex) {
        setFocusableIndex(nextIndex);
        const buttons = gridRef.current?.querySelectorAll('button');
        const nextButton = buttons?.[nextIndex];
        if (nextButton instanceof HTMLElement) {
          nextButton.focus();
        }
      }
    },
    [totalItems]
  );

  const handleStyleSelect = (styleId: string) => {
    onStyleSelect(styleId);
    setDialogOpen(false);
  };

  return (
    <>
      <div
        ref={gridRef}
        className="grid grid-cols-[repeat(auto-fill,minmax(65px,1fr))] gap-3 overflow-hidden p-2"
        role="grid"
        aria-label="Style selection"
      >
        {loading ? (
          Array.from({ length: visibleCount }).map((_, i) => (
            <Skeleton key={i} className="aspect-square rounded-lg" />
          ))
        ) : (
          <>
            {showRecommendationSkeletons &&
              Array.from({ length: recommendationSkeletonCount }, (_, i) => (
                <Skeleton
                  key={`rec-skeleton-${i}`}
                  className="aspect-square rounded-lg"
                />
              ))}
            {visibleStyles.map((style, index) => {
              const cellIndex = recommendationSkeletonCount + index;
              const reasoning = reasoningByStyleId.get(style.id);
              return (
                <button
                  key={style.id}
                  type="button"
                  onClick={() => onStyleSelect(style.id)}
                  onKeyDown={(e) => handleKeyDown(e, cellIndex)}
                  tabIndex={cellIndex === focusableIndex ? 0 : -1}
                  disabled={disabled}
                  className={cn(
                    'group relative aspect-square rounded-lg overflow-hidden',
                    'border-2 transition-all duration-200',
                    'hover:scale-105 hover:shadow-lg',
                    'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    selectedStyleId === style.id
                      ? 'border-primary shadow-md scale-105'
                      : 'border-transparent hover:border-primary/50'
                  )}
                  aria-label={`Select ${style.name} style`}
                  title={reasoning}
                >
                  <StyleTileBackground style={style} />

                  <div className="absolute inset-x-0 bottom-0 p-2 bg-linear-to-t from-black/80 via-black/60 to-transparent">
                    <p className="text-xs font-medium text-white text-center line-clamp-2">
                      {style.name}
                    </p>
                  </div>

                  {selectedStyleId === style.id && (
                    <div className="absolute inset-0 bg-primary/10 pointer-events-none" />
                  )}
                </button>
              );
            })}
          </>
        )}

        {!loading && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            onKeyDown={(e) => handleKeyDown(e, moreIndex)}
            tabIndex={moreIndex === focusableIndex ? 0 : -1}
            disabled={disabled}
            className={cn(
              'aspect-square rounded-lg overflow-hidden',
              'border-2 border-dashed border-muted-foreground/30',
              'flex flex-col items-center justify-center gap-2',
              'hover:border-primary hover:bg-muted/50',
              'transition-all duration-200',
              'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            aria-label={`View all ${styles.length} styles`}
          >
            <MoreHorizontal className="h-5 w-5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground font-medium text-center">
              {hiddenCount > 0
                ? `+${hiddenCount} More`
                : `View All (${styles.length})`}
            </span>
          </button>
        )}
      </div>

      <StyleSelectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        styles={styles}
        selectedStyleId={selectedStyleId}
        onStyleSelect={handleStyleSelect}
        recommendations={recommendations}
      />
    </>
  );
}
