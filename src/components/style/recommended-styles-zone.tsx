import { Skeleton } from '@/components/ui/skeleton';
import type { StyleRecommendation } from '@/hooks/use-styles';
import {
  buildRecommendationReasoningMap,
  RECOMMENDED_STYLE_SLOT_COUNT,
  resolveRecommendedStyles,
} from '@/lib/style/prioritize-recommended-styles';
import type { Style } from '@/lib/db/schema/libraries';
import { cn } from '@/lib/utils';
import { Sparkles } from 'lucide-react';
import { useMemo, type FC, type KeyboardEvent, type ReactNode } from 'react';

type RecommendedStylesZoneProps = {
  recommendations: StyleRecommendation[] | undefined;
  styles: Style[];
  selectedStyleId: string | null;
  isLoading?: boolean;
  /** Render compact composer tiles (passed through from StyleSelector). */
  renderTile: (props: {
    style: Style;
    selected: boolean;
    reasoning?: string;
    tabIndex: number;
    onKeyDown: (event: KeyboardEvent) => void;
  }) => ReactNode;
  /** Skeleton placeholders while recommendations load (keyboard nav owned by parent). */
  renderSkeleton?: (index: number) => ReactNode;
  className?: string;
  /** Column span when embedded in the parent style grid (default: 5 slots). */
  columnSpan?: number;
};

/**
 * Bordered shortlist cluster — occupies the first N grid slots inline so the
 * catalogue continues after it without duplicate styles.
 */
export const RecommendedStylesZone: FC<RecommendedStylesZoneProps> = ({
  recommendations,
  styles,
  selectedStyleId,
  isLoading = false,
  renderTile,
  renderSkeleton,
  className,
  columnSpan = RECOMMENDED_STYLE_SLOT_COUNT,
}) => {
  const resolved = useMemo(
    () => resolveRecommendedStyles(styles, recommendations),
    [styles, recommendations]
  );
  const reasoningByStyleId = useMemo(
    () => buildRecommendationReasoningMap(recommendations),
    [recommendations]
  );

  const showSkeleton = isLoading && resolved.length === 0;
  if (!showSkeleton && resolved.length === 0) return null;

  const columnSpanClass =
    columnSpan === RECOMMENDED_STYLE_SLOT_COUNT
      ? 'col-span-5'
      : 'col-span-full';

  return (
    <section
      data-recommended-zone
      aria-label="Recommended styles for your script"
      className={cn(
        columnSpanClass,
        'rounded-xl border border-primary/20 bg-gradient-to-br from-primary/[0.06] via-primary/[0.02] to-transparent',
        'px-2.5 pt-2 pb-2.5 shadow-sm min-w-0',
        className
      )}
    >
      <div className="mb-2 flex items-center gap-1.5 px-0.5">
        <Sparkles className="size-3 shrink-0 text-primary" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-primary/90">
          For your script
        </span>
      </div>
      <div className="grid grid-cols-5 gap-3">
        {showSkeleton
          ? Array.from({ length: RECOMMENDED_STYLE_SLOT_COUNT }, (_, i) =>
              renderSkeleton ? (
                renderSkeleton(i)
              ) : (
                <Skeleton
                  key={`rec-skeleton-${i}`}
                  className="aspect-square rounded-lg"
                />
              )
            )
          : resolved.map((style) =>
              renderTile({
                style,
                selected: selectedStyleId === style.id,
                reasoning: reasoningByStyleId.get(style.id),
                tabIndex: -1,
                onKeyDown: () => {},
              })
            )}
      </div>
    </section>
  );
};
