import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { StyleRecommendation } from '@/hooks/use-styles';
import {
  catalogueWithoutRecommendations,
  resolveRecommendedStyles,
} from '@/lib/style/prioritize-recommended-styles';
import { RecommendedStylesZone } from '@/components/style/recommended-styles-zone';
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

  const showRecommendationZone =
    recommendationsLoading || (recommendations?.length ?? 0) > 0;

  const catalogueStyles = useMemo(
    () =>
      showRecommendationZone
        ? catalogueWithoutRecommendations(
            styles,
            recommendations,
            selectedStyleId
          )
        : catalogueWithoutRecommendations(styles, undefined, selectedStyleId),
    [styles, recommendations, selectedStyleId, showRecommendationZone]
  );

  const maxCatalogueSlots = Math.max(0, visibleCount - reservedSlots);
  const visibleCatalogueStyles = catalogueStyles.slice(0, maxCatalogueSlots);
  const recommendedVisibleCount = showRecommendationZone
    ? resolveRecommendedStyles(styles, recommendations).length
    : 0;
  const hiddenCount = Math.max(
    0,
    styles.length - visibleCatalogueStyles.length - recommendedVisibleCount
  );
  const moreIndex = visibleCatalogueStyles.length;
  const totalItems = moreIndex + 1;

  useEffect(() => {
    if (visibleCatalogueStyles.length === 0) return;

    const selectedIndex = visibleCatalogueStyles.findIndex(
      (s) => s.id === selectedStyleId
    );
    setFocusableIndex(selectedIndex !== -1 ? selectedIndex : 0);
  }, [selectedStyleId, visibleCatalogueStyles]);

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
      <div className="flex flex-col gap-2.5">
        {showRecommendationZone && !loading && (
          <RecommendedStylesZone
            recommendations={recommendations}
            styles={styles}
            selectedStyleId={selectedStyleId}
            isLoading={recommendationsLoading}
            renderTile={(props) => (
              <StyleInlineTile
                key={props.style.id}
                style={props.style}
                selected={props.selected}
                disabled={disabled}
                reasoning={props.reasoning}
                tabIndex={props.tabIndex}
                onSelect={onStyleSelect}
                onKeyDown={props.onKeyDown}
              />
            )}
          />
        )}

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
              {visibleCatalogueStyles.map((style, index) => (
                <StyleInlineTile
                  key={style.id}
                  style={style}
                  selected={selectedStyleId === style.id}
                  disabled={disabled}
                  tabIndex={index === focusableIndex ? 0 : -1}
                  onSelect={onStyleSelect}
                  onKeyDown={(e) => handleKeyDown(e, index)}
                />
              ))}

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
