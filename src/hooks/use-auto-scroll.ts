import { useEffect, useRef } from 'react';

type UseAutoScrollOptions = {
  enabled: boolean;
  content: string;
};

const BOTTOM_THRESHOLD = 20;

export function useAutoScroll<T extends HTMLElement = HTMLElement>({
  enabled,
  content,
}: UseAutoScrollOptions) {
  const ref = useRef<T | null>(null);
  const shouldAutoScrollRef = useRef(true);

  // Effect 1: Attach scroll listener when enabled, track user scroll position
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el) return;

    shouldAutoScrollRef.current = true;

    const onScroll = () => {
      const nearBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - BOTTOM_THRESHOLD;
      shouldAutoScrollRef.current = nearBottom;
    };

    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [enabled]);

  // Effect 2: Scroll to bottom when content changes during streaming
  useEffect(() => {
    const el = ref.current;
    if (!enabled || !el || !shouldAutoScrollRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [content, enabled]);

  return { ref };
}
