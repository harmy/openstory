import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StyleRecommendation } from '@/hooks/use-styles';
import {
  buildRecommendationReasoningMap,
  catalogueWithoutRecommendations,
  RECOMMENDED_STYLE_SLOT_COUNT,
  resolveRecommendedStyles,
} from '@/lib/style/prioritize-recommended-styles';
import { StyleInlineTile } from '@/components/style/style-inline-tile';
import { StyleSelectionDialog } from './style-selection-dialog';
import type { Style } from '@/lib/db/schema/libraries';

type StyleSelectorProps = {
  styles: Style[];
  selectedStyleId: string | null;
  onStyleSelect: (styleId: string) => void;
  loading?: boolean;
  disabled?: boolean;
  recommendations?: StyleRecommendation[];
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

  const showRecommendations =
    recommendationsLoading || (recommendations?.length ?? 0) > 0;

  const recommendedStyles = useMemo(
    () =>
      showRecommendations
        ? resolveRecommendedStyles(styles, recommendations)
        : [],
    [styles, recommendations, showRecommendations]
  );

  const reasoningByStyleId = useMemo(
    () => buildRecommendationReasoningMap(recommendations),
    [recommendations]
  );

  const showRecommendationSkeleton =
    showRecommendations &&
    recommendationsLoading &&
    recommendedStyles.length === 0;

  const recommendationSlotCount = showRecommendations
    ? showRecommendationSkeleton
      ? RECOMMENDED_STYLE_SLOT_COUNT
      : recommendedStyles.length
    : 0;

  const catalogueStyles = useMemo(
    () =>
      catalogueWithoutRecommendations(
        styles,
        showRecommendations ? recommendations : undefined,
        selectedStyleId
      ),
    [styles, recommendations, selectedStyleId, showRecommendations]
  );

  const maxCatalogueSlots = Math.max(
    0,
    visibleCount - reservedSlots - recommendationSlotCount
  );
  const visibleCatalogueStyles = catalogueStyles.slice(0, maxCatalogueSlots);

  const moreIndex = recommendationSlotCount + visibleCatalogueStyles.length;
  const totalItems = moreIndex + 1;

  const shownStyleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const style of recommendedStyles) ids.add(style.id);
    for (const style of visibleCatalogueStyles) ids.add(style.id);
    return ids;
  }, [recommendedStyles, visibleCatalogueStyles]);

  const hiddenCount = Math.max(0, styles.length - shownStyleIds.size);

  useEffect(() => {
    const recIndex = recommendedStyles.findIndex(
      (s) => s.id === selectedStyleId
    );
    if (recIndex !== -1) {
      setFocusableIndex(recIndex);
      return;
    }

    const catalogueIndex = visibleCatalogueStyles.findIndex(
      (s) => s.id === selectedStyleId
    );
    if (catalogueIndex !== -1) {
      setFocusableIndex(recommendationSlotCount + catalogueIndex);
      return;
    }

    if (totalItems > 0) setFocusableIndex(0);
  }, [
    selectedStyleId,
    recommendedStyles,
    visibleCatalogueStyles,
    recommendationSlotCount,
    totalItems,
  ]);

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
            {showRecommendationSkeleton
              ? Array.from({ length: RECOMMENDED_STYLE_SLOT_COUNT }, (_, i) => (
                  <Skeleton
                    key={`rec-skeleton-${i}`}
                    className="aspect-square rounded-lg"
                  />
                ))
              : recommendedStyles.map((style, index) => (
                  <StyleInlineTile
                    key={style.id}
                    style={style}
                    selected={selectedStyleId === style.id}
                    disabled={disabled}
                    reasoning={reasoningByStyleId.get(style.id)}
                    tabIndex={index === focusableIndex ? 0 : -1}
                    onSelect={onStyleSelect}
                    onKeyDown={(e) => handleKeyDown(e, index)}
                  />
                ))}

            {visibleCatalogueStyles.map((style, index) => {
              const unifiedIndex = recommendationSlotCount + index;
              return (
                <StyleInlineTile
                  key={style.id}
                  style={style}
                  selected={selectedStyleId === style.id}
                  disabled={disabled}
                  tabIndex={unifiedIndex === focusableIndex ? 0 : -1}
                  onSelect={onStyleSelect}
                  onKeyDown={(e) => handleKeyDown(e, unifiedIndex)}
                />
              );
            })}

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
          </>
        )}
      </div>

      <StyleSelectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        styles={styles}
        selectedStyleId={selectedStyleId}
        onStyleSelect={handleStyleSelect}
        recommendations={recommendations}
        recommendationsLoading={recommendationsLoading}
      />
    </>
  );
}
