import type { RefObject } from 'react';
import { useEffect, useState, type FC } from 'react';
import { cn } from '@/lib/utils';

const FRAME_PAD = 8;
const TILE_BLEED = 4;

type RecommendStylesClusterFrameProps = {
  containerRef: RefObject<HTMLElement | null>;
  active: boolean;
  className?: string;
};

/**
 * Draws a border around the recommend trigger and inline `[data-recommended-tile]`
 * cells without changing grid layout.
 */
export const RecommendStylesClusterFrame: FC<
  RecommendStylesClusterFrameProps
> = ({ containerRef, active, className }) => {
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
      const elements = container.querySelectorAll(
        '[data-recommend-trigger], [data-recommended-tile]'
      );
      if (elements.length === 0) {
        setBounds(null);
        return;
      }

      const containerRect = container.getBoundingClientRect();
      let minTop = Infinity;
      let minLeft = Infinity;
      let maxRight = -Infinity;
      let maxBottom = -Infinity;

      for (const element of elements) {
        const rect = element.getBoundingClientRect();
        minTop = Math.min(minTop, rect.top);
        minLeft = Math.min(minLeft, rect.left);
        maxRight = Math.max(maxRight, rect.right);
        maxBottom = Math.max(maxBottom, rect.bottom);
      }

      setBounds({
        top: minTop - containerRect.top - FRAME_PAD,
        left: minLeft - containerRect.left - FRAME_PAD - TILE_BLEED,
        width: maxRight - minLeft + (FRAME_PAD + TILE_BLEED) * 2,
        height: maxBottom - minTop + FRAME_PAD * 2,
      });
    };

    measure();

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(container);

    const mutationObserver = new MutationObserver(measure);
    mutationObserver.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    return () => {
      resizeObserver.disconnect();
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
    />
  );
};
