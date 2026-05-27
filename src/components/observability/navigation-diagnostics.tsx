import { useRouter } from '@tanstack/react-router';
import { usePostHog } from '@posthog/react';
import { useEffect } from 'react';

/**
 * Captures evidence for navigation failures we can't reproduce — specifically
 * the "Can't open this page" error iOS Chrome shows when its WebProcess dies
 * mid-navigation. PostHog's built-in `capture_exceptions` only catches errors
 * that reach the JS handler; a WebKit crash never gets to dispatch one.
 *
 * Strategy: log every navigation lifecycle event with a monotonic id, and on
 * `pagehide` (which iOS fires before backgrounding/terminating a page) flush
 * any unresolved navigation so we can see how far it got.
 */
export const NavigationDiagnostics: React.FC = () => {
  const router = useRouter();
  const posthog = usePostHog();

  useEffect(() => {
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: posthog is undefined when VITE_PUBLIC_POSTHOG_PROJECT_TOKEN is unset
    if (!posthog) return;

    type NavRecord = {
      id: number;
      fromHref: string;
      toHref: string;
      startedAt: number;
      stages: Array<{ type: string; at: number }>;
    };

    let navCounter = 0;
    let current: NavRecord | null = null;
    const beaconOptions = {
      transport: 'sendBeacon' as const,
      send_instantly: true,
    };

    const capture = (
      event: string,
      props: Record<string, unknown>,
      immediate = false
    ) => {
      posthog.capture(event, props, immediate ? beaconOptions : undefined);
    };

    const stamp = (type: string) => {
      if (!current) return;
      current.stages.push({ type, at: performance.now() });
    };

    const events = [
      'onBeforeNavigate',
      'onBeforeLoad',
      'onLoad',
      'onBeforeRouteMount',
      'onResolved',
      'onRendered',
    ] as const;

    const unsubs = events.map((eventType) =>
      router.subscribe(eventType, (e) => {
        if (eventType === 'onBeforeNavigate') {
          navCounter += 1;
          current = {
            id: navCounter,
            fromHref: e.fromLocation?.href ?? '(initial)',
            toHref: e.toLocation.href,
            startedAt: performance.now(),
            stages: [{ type: 'onBeforeNavigate', at: performance.now() }],
          };
          capture('navigation_started', {
            nav_id: current.id,
            from: current.fromHref,
            to: current.toHref,
          });
          return;
        }
        stamp(eventType);
        if (eventType === 'onRendered' && current) {
          const nav = current;
          capture('navigation_completed', {
            nav_id: nav.id,
            from: nav.fromHref,
            to: nav.toHref,
            duration_ms: performance.now() - nav.startedAt,
            stages: nav.stages.map((s) => ({
              type: s.type,
              at_ms: Math.round(s.at - nav.startedAt),
            })),
          });
          current = null;
        }
      })
    );

    const flushPending = (reason: string) => {
      if (!current) return;
      const nav = current;
      capture(
        'navigation_unfinished',
        {
          nav_id: nav.id,
          from: nav.fromHref,
          to: nav.toHref,
          duration_ms: performance.now() - nav.startedAt,
          last_stage: nav.stages[nav.stages.length - 1]?.type ?? 'unknown',
          stages: nav.stages.map((s) => ({
            type: s.type,
            at_ms: Math.round(s.at - nav.startedAt),
          })),
          reason,
          user_agent: navigator.userAgent,
        },
        true
      );
      current = null;
    };

    const onPageHide = () => flushPending('pagehide');
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') {
        flushPending('visibilitychange:hidden');
      }
    };
    const onError = (e: ErrorEvent) => {
      capture('navigation_window_error', {
        nav_id: current?.id ?? null,
        message: e.message,
        filename: e.filename,
        lineno: e.lineno,
        colno: e.colno,
        to: current?.toHref ?? null,
      });
    };
    const onRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      capture('navigation_unhandled_rejection', {
        nav_id: current?.id ?? null,
        message: reason instanceof Error ? reason.message : String(reason),
        to: current?.toHref ?? null,
      });
    };

    // Capture in-DOM link clicks at the document level so we can distinguish
    // "user tapped but TanStack Router never ran handleClick" from "router ran
    // but didn't reach onRendered". Use the capture phase so we run before any
    // stopPropagation upstream of us.
    const onDocumentClick = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      const anchor = target.closest('a');
      if (!anchor) return;
      const href = anchor.getAttribute('href');
      if (!href) return;
      capture('navigation_link_clicked', {
        href,
        default_prevented: e.defaultPrevented,
        button: e.button,
        modifier: e.metaKey || e.ctrlKey || e.shiftKey || e.altKey,
        target_attr: anchor.getAttribute('target'),
      });
    };

    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);
    document.addEventListener('click', onDocumentClick, true);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);

    return () => {
      for (const unsub of unsubs) unsub();
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      document.removeEventListener('click', onDocumentClick, true);
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, [router, posthog]);

  return null;
};
