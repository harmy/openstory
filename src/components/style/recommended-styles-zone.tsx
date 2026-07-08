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
  className?: string;
};

/**
 * Bordered shortlist cluster — visually separates script-driven picks from the
 * main catalogue without changing tile size.
 */
export const RecommendedStylesZone: FC<RecommendedStylesZoneProps> = ({
  recommendations,
  styles,
  selectedStyleId,
  isLoading = false,
  renderTile,
  className,
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

  const focusableIndex = Math.max(
    0,
    resolved.findIndex((s) => s.id === selectedStyleId)
  );

  const handleKeyDown = (event: KeyboardEvent, index: number) => {
    const total = showSkeleton ? RECOMMENDED_STYLE_SLOT_COUNT : resolved.length;
    let next = index;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowDown':
        event.preventDefault();
        next = Math.min(index + 1, total - 1);
        break;
      case 'ArrowLeft':
      case 'ArrowUp':
        event.preventDefault();
        next = Math.max(index - 1, 0);
        break;
      case 'Home':
        event.preventDefault();
        next = 0;
        break;
      case 'End':
        event.preventDefault();
        next = total - 1;
        break;
      default:
        return;
    }
    if (next !== index) {
      const section = event.currentTarget.closest('[data-recommended-zone]');
      const buttons = section?.querySelectorAll('button');
      const nextButton = buttons?.[next];
      if (nextButton instanceof HTMLElement) nextButton.focus();
    }
  };

  return (
    <section
      data-recommended-zone
      aria-label="Recommended styles for your script"
      className={cn(
        'rounded-xl border border-primary/20 bg-gradient-to-br from-primary/[0.06] via-primary/[0.02] to-transparent',
        'px-2.5 pt-2 pb-2.5 shadow-sm',
        className
      )}
    >
      <div className="mb-2 flex items-center gap-1.5 px-0.5">
        <Sparkles className="size-3 shrink-0 text-primary" aria-hidden />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-primary/90">
          For your script
        </span>
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(65px,1fr))] gap-3">
        {showSkeleton
          ? Array.from({ length: RECOMMENDED_STYLE_SLOT_COUNT }, (_, i) => (
              <Skeleton
                key={`rec-skeleton-${i}`}
                className="aspect-square rounded-lg"
              />
            ))
          : resolved.map((style, index) =>
              renderTile({
                style,
                selected: selectedStyleId === style.id,
                reasoning: reasoningByStyleId.get(style.id),
                tabIndex: index === focusableIndex ? 0 : -1,
                onKeyDown: (event) => handleKeyDown(event, index),
              })
            )}
      </div>
    </section>
  );
};
