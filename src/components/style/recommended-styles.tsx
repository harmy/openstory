import { StyleHoverPreview } from '@/components/style/style-hover-preview';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { StyleRecommendation } from '@/hooks/use-styles';
import { cn } from '@/lib/utils';
import type { Style } from '@/types/database';
import { Sparkles } from 'lucide-react';
import { useMemo, type FC, type KeyboardEvent } from 'react';

type RecommendedStylesProps = {
  /** Ranked picks from `useRecommendedStyles`; `undefined` while never run. */
  recommendations: StyleRecommendation[] | undefined;
  styles: Style[];
  selectedStyleId: string | null;
  onStyleSelect: (styleId: string) => void;
  isLoading?: boolean;
  className?: string;
};

type ResolvedRecommendation = { style: Style; reasoning: string };

/**
 * "Recommended for your script" shortlist — the LLM-ranked picks joined back to
 * their full `Style` rows and rendered as compact, clickable tiles with a
 * one-line reason. Renders nothing when there's no script-driven shortlist yet
 * (so it hides gracefully), and a skeleton row while the ranking is in flight.
 */
export const RecommendedStyles: FC<RecommendedStylesProps> = ({
  recommendations,
  styles,
  selectedStyleId,
  onStyleSelect,
  isLoading = false,
  className,
}) => {
  const resolved = useMemo<ResolvedRecommendation[]>(() => {
    if (!recommendations) return [];
    const byId = new Map(styles.map((s) => [s.id, s]));
    return recommendations
      .map((r) => {
        const style = byId.get(r.styleId);
        return style ? { style, reasoning: r.reasoning } : null;
      })
      .filter((r): r is ResolvedRecommendation => r !== null);
  }, [recommendations, styles]);

  const showSkeleton = isLoading && resolved.length === 0;

  // Nothing computed and nothing loading → hide entirely.
  if (!showSkeleton && resolved.length === 0) return null;

  const handleKeyDown = (event: KeyboardEvent, styleId: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onStyleSelect(styleId);
    }
  };

  return (
    <section
      className={cn('flex flex-col gap-2', className)}
      aria-label="Recommended styles for your script"
    >
      <div className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
        <Sparkles className="size-3.5 text-primary" />
        Recommended for your script
      </div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(96px,1fr))] gap-3">
        {showSkeleton
          ? Array.from({ length: 5 }, (_, i) => (
              <Card key={`rec-skeleton-${i}`}>
                <CardContent className="p-0">
                  <Skeleton className="aspect-square rounded-t-lg" />
                  <div className="flex flex-col gap-1 p-2">
                    <Skeleton className="mx-auto h-3 w-3/4" />
                    <Skeleton className="mx-auto h-2.5 w-full" />
                  </div>
                </CardContent>
              </Card>
            ))
          : resolved.map(({ style, reasoning }) => (
              <Card
                key={style.id}
                role="button"
                className={cn(
                  'cursor-pointer transition-all hover:shadow-lg hover:scale-105',
                  selectedStyleId === style.id &&
                    'ring-2 ring-primary ring-offset-2'
                )}
                onClick={() => onStyleSelect(style.id)}
                onKeyDown={(e) => handleKeyDown(e, style.id)}
                tabIndex={0}
                aria-pressed={selectedStyleId === style.id}
                aria-label={`Select ${style.name}${reasoning ? ` — ${reasoning}` : ''}`}
                title={reasoning || style.name}
                data-testid={`recommended-style-${style.id}`}
              >
                <CardContent className="p-0">
                  <StyleHoverPreview style={style} className="rounded-t-lg" />
                  <div className="p-2">
                    <h3 className="truncate text-center text-xs font-semibold uppercase tracking-wider">
                      {style.name}
                    </h3>
                    {reasoning && (
                      <p className="mt-0.5 line-clamp-2 text-center text-[11px] leading-tight text-muted-foreground">
                        {reasoning}
                      </p>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
      </div>
    </section>
  );
};
