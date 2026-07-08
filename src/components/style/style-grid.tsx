import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import type { StyleRecommendation } from '@/hooks/use-styles';
import {
  buildRecommendationReasoningMap,
  RECOMMENDED_STYLE_SLOT_COUNT,
  resolveRecommendedStyles,
} from '@/lib/style/prioritize-recommended-styles';
import type { Style } from '@/types/database';
import type { FC, KeyboardEvent, ReactNode } from 'react';
import { useCallback, useRef, useEffect, useMemo, useState } from 'react';

import { StyleHoverPreview } from './style-hover-preview';

type StyleGridProps = {
  styles: Style[];
  selectedStyleId: string | null;
  onStyleSelect: (styleId: string) => void;
  onStyleSelectAndClose?: (styleId: string) => void;
  isLoading?: boolean;
  allStyles?: Style[];
  recommendations?: StyleRecommendation[];
  recommendationsLoading?: boolean;
  renderRecommendedTile?: (props: {
    style: Style;
    selected: boolean;
    reasoning?: string;
    tabIndex: number;
    onKeyDown: (event: KeyboardEvent) => void;
  }) => ReactNode;
};

type StyleCardProps = {
  style: Style;
  selected: boolean;
  onSelect: (styleId: string) => void;
  onSelectAndClose?: (styleId: string) => void;
  tabIndex?: number;
  onKeyDown?: (event: KeyboardEvent, styleId: string) => void;
};

const StyleCard: FC<StyleCardProps> = ({
  style,
  selected,
  onSelect,
  onSelectAndClose,
  tabIndex = -1,
  onKeyDown: onKeyDownProp,
}) => {
  const handleClick = useCallback(() => {
    onSelect(style.id);
  }, [style.id, onSelect]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent) => {
      // Handle arrow keys and grid navigation first (if provided)
      if (onKeyDownProp) {
        onKeyDownProp(event, style.id);
        // If arrow key navigation handled the event, don't process further
        if (
          event.key === 'ArrowLeft' ||
          event.key === 'ArrowRight' ||
          event.key === 'ArrowUp' ||
          event.key === 'ArrowDown'
        ) {
          return;
        }
      }

      // Handle Enter/Space for selection
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        if (selected && event.key === 'Enter' && onSelectAndClose) {
          // If already selected, close the dialog
          onSelectAndClose(style.id);
        } else {
          // Otherwise just select it
          handleClick();
        }
      }
    },
    [handleClick, onSelectAndClose, style.id, selected, onKeyDownProp]
  );

  const styleName = style.name ? style.name.toUpperCase() : undefined;

  return (
    <Card
      className={cn(
        'cursor-pointer transition-all hover:shadow-lg hover:scale-105',
        selected && 'ring-2 ring-primary ring-offset-2'
      )}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      tabIndex={tabIndex}
      aria-pressed={selected}
      data-testid={`style-card-${style.id}`}
    >
      <CardContent className="p-0">
        <StyleHoverPreview style={style} className="rounded-t-lg" />
        <div className="p-3">
          <h3
            className="text-center text-xs font-semibold uppercase tracking-wider"
            title={styleName}
          >
            {styleName}
          </h3>
        </div>
      </CardContent>
    </Card>
  );
};

const StyleCardSkeleton = () => (
  <Card>
    <CardContent className="p-0">
      <Skeleton className="aspect-square rounded-t-lg" />
      <div className="p-3">
        <Skeleton className="mx-auto h-3 w-3/4" />
      </div>
    </CardContent>
  </Card>
);

export const StyleGrid: FC<StyleGridProps> = ({
  styles,
  selectedStyleId,
  onStyleSelect,
  onStyleSelectAndClose,
  isLoading = false,
  allStyles,
  recommendations,
  recommendationsLoading = false,
  renderRecommendedTile,
}) => {
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusableIndex, setFocusableIndex] = useState(0);

  const showRecommendationZone =
    recommendationsLoading || (recommendations?.length ?? 0) > 0;

  const recommendedStyles = useMemo(
    () =>
      showRecommendationZone && allStyles
        ? resolveRecommendedStyles(allStyles, recommendations)
        : [],
    [allStyles, recommendations, showRecommendationZone]
  );

  const showRecommendationSkeleton =
    showRecommendationZone &&
    recommendationsLoading &&
    recommendedStyles.length === 0;

  const recommendedTileCount = showRecommendationZone
    ? showRecommendationSkeleton
      ? RECOMMENDED_STYLE_SLOT_COUNT
      : recommendedStyles.length
    : 0;

  const reasoningByStyleId = useMemo(
    () => buildRecommendationReasoningMap(recommendations),
    [recommendations]
  );

  const catalogueStyles = styles;

  useEffect(() => {
    const recIndex = recommendedStyles.findIndex(
      (s) => s.id === selectedStyleId
    );
    if (recIndex !== -1) {
      setFocusableIndex(recIndex);
      return;
    }

    const catalogueIndex = catalogueStyles.findIndex(
      (s) => s.id === selectedStyleId
    );
    if (catalogueIndex !== -1) {
      setFocusableIndex(recommendedTileCount + catalogueIndex);
      return;
    }

    if (catalogueStyles.length > 0 || recommendedTileCount > 0) {
      setFocusableIndex(0);
    }
  }, [
    selectedStyleId,
    catalogueStyles,
    recommendedStyles,
    recommendedTileCount,
  ]);

  // Calculate actual grid columns from the rendered layout
  const getColumnsCount = useCallback(() => {
    if (!gridRef.current) return 2; // default

    // Get the first two cards to calculate column count
    const cards = gridRef.current.querySelectorAll(
      '[data-testid^="style-card-"]'
    );
    if (cards.length < 2) return 1;

    const firstCard = cards[0];
    const secondCard = cards[1];
    if (
      !(firstCard instanceof HTMLElement) ||
      !(secondCard instanceof HTMLElement)
    ) {
      return 1;
    }

    // Get the actual positions
    const firstRect = firstCard.getBoundingClientRect();
    const secondRect = secondCard.getBoundingClientRect();

    // If they're on the same row (top positions are close), they're in different columns
    if (Math.abs(firstRect.top - secondRect.top) < 5) {
      // Calculate columns based on card width and container width
      const containerRect = gridRef.current.getBoundingClientRect();
      const cardWidth = firstRect.width;
      const gap = secondRect.left - firstRect.right;
      const availableWidth = containerRect.width;

      // Calculate how many cards fit per row
      const cols = Math.floor((availableWidth + gap) / (cardWidth + gap));
      return Math.max(1, cols);
    }

    // If second card is below the first, we have 1 column
    return 1;
  }, []);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent, currentStyleId: string) => {
      const recIndex = recommendedStyles.findIndex(
        (s) => s.id === currentStyleId
      );
      const catalogueIndex = catalogueStyles.findIndex(
        (s) => s.id === currentStyleId
      );
      const currentIndex =
        recIndex !== -1
          ? recIndex
          : catalogueIndex !== -1
            ? recommendedTileCount + catalogueIndex
            : -1;
      if (currentIndex === -1) return;

      let nextIndex = currentIndex;
      const cols = getColumnsCount();
      const totalItems = recommendedTileCount + catalogueStyles.length;

      switch (event.key) {
        case 'ArrowRight':
          event.preventDefault();
          nextIndex = Math.min(currentIndex + 1, totalItems - 1);
          break;
        case 'ArrowLeft':
          event.preventDefault();
          nextIndex = Math.max(currentIndex - 1, 0);
          break;
        case 'ArrowDown':
          event.preventDefault();
          nextIndex = Math.min(currentIndex + cols, totalItems - 1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          nextIndex = Math.max(currentIndex - cols, 0);
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

      // Update focusable index and move focus
      if (nextIndex !== currentIndex) {
        setFocusableIndex(nextIndex);

        const focusable = gridRef.current?.querySelectorAll<HTMLElement>(
          '[data-style-grid-tile] button, [data-testid^="style-card-"]'
        );
        const nextEl = focusable?.[nextIndex];
        if (nextEl instanceof HTMLElement) {
          nextEl.focus();
        }
      }
    },
    [catalogueStyles, recommendedStyles, recommendedTileCount, getColumnsCount]
  );

  return (
    <div
      ref={gridRef}
      className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 p-4 overflow-auto"
      data-testid="style-grid"
      role="grid"
      aria-label="Style selection grid"
    >
      {isLoading ? (
        Array.from({ length: 10 }, (_, index) => (
          <StyleCardSkeleton key={`skeleton-${index}`} />
        ))
      ) : (
        <>
          {showRecommendationZone &&
            allStyles &&
            renderRecommendedTile &&
            (showRecommendationSkeleton
              ? Array.from({ length: RECOMMENDED_STYLE_SLOT_COUNT }, (_, i) => (
                  <Skeleton
                    key={`rec-skeleton-${i}`}
                    data-style-grid-tile
                    className="aspect-square rounded-lg"
                  />
                ))
              : recommendedStyles.map((style, index) => (
                  <div key={style.id} data-style-grid-tile>
                    {renderRecommendedTile({
                      style,
                      selected: selectedStyleId === style.id,
                      reasoning: reasoningByStyleId.get(style.id),
                      tabIndex: index === focusableIndex ? 0 : -1,
                      onKeyDown: (event) => handleKeyDown(event, style.id),
                    })}
                  </div>
                )))}
          {catalogueStyles.map((style, index) => {
            const unifiedIndex = recommendedTileCount + index;
            return (
              <StyleCard
                key={style.id}
                style={style}
                selected={selectedStyleId === style.id}
                onSelect={onStyleSelect}
                onSelectAndClose={onStyleSelectAndClose}
                tabIndex={unifiedIndex === focusableIndex ? 0 : -1}
                onKeyDown={handleKeyDown}
              />
            );
          })}
        </>
      )}
    </div>
  );
};
