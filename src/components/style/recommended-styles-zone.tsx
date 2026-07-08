import { Skeleton } from '@/components/ui/skeleton';
import type { StyleRecommendation } from '@/hooks/use-styles';
import {
  buildRecommendationReasoningMap,
  RECOMMENDED_STYLE_SLOT_COUNT,
  resolveRecommendedStyles,
} from '@/lib/style/prioritize-recommended-styles';
import type { Style } from '@/lib/db/schema/libraries';
import { cn } from '@/lib/utils';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import { StyleInlineTile } from './style-inline-tile';

type RecommendStylesShellProps = {
  active: boolean;
  children: ReactNode;
  className?: string;
};

/** Bordered cluster around the recommend trigger and its shortlist tiles. */
export const RecommendStylesShell: FC<RecommendStylesShellProps> = ({
  active,
  children,
  className,
}) => {
  if (!active) return <>{children}</>;

  return (
    <div
      className={cn(
        'rounded-xl border border-primary/20',
        'bg-gradient-to-br from-primary/[0.06] via-primary/[0.02] to-transparent',
        'p-2.5 shadow-sm flex flex-col gap-3',
        className
      )}
    >
      {children}
    </div>
  );
};

type RecommendedStylesRowProps = {
  styles: Style[];
  recommendations?: StyleRecommendation[];
  recommendationsLoading?: boolean;
  selectedStyleId: string | null;
  onStyleSelect: (styleId: string) => void;
  loading?: boolean;
  disabled?: boolean;
};

export const RecommendedStylesRow: FC<RecommendedStylesRowProps> = ({
  styles,
  recommendations,
  recommendationsLoading = false,
  selectedStyleId,
  onStyleSelect,
  loading = false,
  disabled = false,
}) => {
  const rowRef = useRef<HTMLDivElement>(null);
  const [focusableIndex, setFocusableIndex] = useState(0);

  const recommendedStyles = useMemo(
    () => resolveRecommendedStyles(styles, recommendations),
    [styles, recommendations]
  );

  const reasoningByStyleId = useMemo(
    () => buildRecommendationReasoningMap(recommendations),
    [recommendations]
  );

  const showSkeleton = recommendationsLoading && recommendedStyles.length === 0;
  const tileCount = showSkeleton
    ? RECOMMENDED_STYLE_SLOT_COUNT
    : recommendedStyles.length;

  useEffect(() => {
    const selectedIndex = recommendedStyles.findIndex(
      (s) => s.id === selectedStyleId
    );
    setFocusableIndex(selectedIndex !== -1 ? selectedIndex : 0);
  }, [selectedStyleId, recommendedStyles]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent, currentIndex: number) => {
      if (tileCount === 0) return;
      let nextIndex = currentIndex;

      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          nextIndex = Math.min(currentIndex + 1, tileCount - 1);
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
          nextIndex = tileCount - 1;
          break;
        default:
          return;
      }

      if (nextIndex !== currentIndex) {
        setFocusableIndex(nextIndex);
        const buttons = rowRef.current?.querySelectorAll('button');
        const nextButton = buttons?.[nextIndex];
        if (nextButton instanceof HTMLElement) nextButton.focus();
      }
    },
    [tileCount]
  );

  if (!showSkeleton && recommendedStyles.length === 0) return null;

  return (
    <div
      ref={rowRef}
      className="grid grid-cols-[repeat(auto-fill,minmax(65px,1fr))] gap-3"
      aria-label="Recommended styles"
    >
      {loading || showSkeleton
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
    </div>
  );
};
