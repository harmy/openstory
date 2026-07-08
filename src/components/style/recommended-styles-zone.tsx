import type { RefObject } from 'react';
import { useEffect, useState, type FC } from 'react';
import { cn } from '@/lib/utils';
import { Sparkles } from 'lucide-react';

const FRAME_PAD = 6;
const LABEL_HEIGHT = 22;

type RecommendedStylesFrameProps = {
  containerRef: RefObject<HTMLElement | null>;
  active: boolean;
  className?: string;
};

/**
 * Decorative border drawn around `[data-recommended-tile]` cells without
 * changing grid layout — tiles stay one cell each at the same size as peers.
 */
export const RecommendedStylesFrame: FC<RecommendedStylesFrameProps> = ({
  containerRef,
  active,
  className,
}) => {
  const [bounds, setBounds] = useState<{
    top: number;
    left: number;
    width: number;
    height: number;
  } | null>(null);

  useEffect(() => {
    if (!active) {
      setBounds(null);
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const measure = () => {
      const tiles = container.querySelectorAll('[data-recommended-tile]');
      if (tiles.length === 0) {
        setBounds(null);
        return;
      }

      const containerRect = container.getBoundingClientRect();
      let minTop = Infinity;
      let minLeft = Infinity;
      let maxRight = -Infinity;
      let maxBottom = -Infinity;

      for (const tile of tiles) {
        const rect = tile.getBoundingClientRect();
        minTop = Math.min(minTop, rect.top);
        minLeft = Math.min(minLeft, rect.left);
        maxRight = Math.max(maxRight, rect.right);
        maxBottom = Math.max(maxBottom, rect.bottom);
      }

      setBounds({
        top: minTop - containerRect.top - FRAME_PAD - LABEL_HEIGHT,
        left: minLeft - containerRect.left - FRAME_PAD,
        width: maxRight - minLeft + FRAME_PAD * 2,
        height: maxBottom - minTop + FRAME_PAD * 2 + LABEL_HEIGHT,
      });
    };

    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(container);

    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    return () => {
      observer.disconnect();
      mutationObserver.disconnect();
    };
  }, [active, containerRef]);

  if (!bounds) return null;

  return (
    <div
      aria-hidden
      className={cn(
        'pointer-events-none absolute z-0 rounded-xl border border-primary/20',
        'bg-gradient-to-br from-primary/[0.06] via-primary/[0.02] to-transparent shadow-sm',
        className
      )}
      style={{
        top: bounds.top,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      }}
    >
      <div className="absolute top-1.5 left-2.5 flex items-center gap-1.5">
        <Sparkles className="size-3 shrink-0 text-primary" />
        <span className="text-[11px] font-semibold text-primary/90">
          Recommended styles
        </span>
      </div>
    </div>
  );
};
