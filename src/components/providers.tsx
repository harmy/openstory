import { PostHogIdentify } from '@/components/observability/posthog-identify';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { PostHogProvider } from '@posthog/react';
import type { QueryClient } from '@tanstack/react-query';
import { QueryClientProvider } from '@tanstack/react-query';
import { RealtimeProvider } from '@upstash/realtime/client';
import { lazy, type FC } from 'react';

// Wrap the entire lazy() in import.meta.env.DEV so Vite dead-code-eliminates
// the dynamic imports before rollup tries to resolve them. This prevents
// @tanstack/ai-devtools-core's Solid.js transitive imports from breaking the build.
const TanStackDevtoolsLazy: FC =
  import.meta.env.DEV && !import.meta.env.VITE_DISABLE_DEVTOOLS
    ? lazy(async () => {
        const [
          { TanStackDevtools },
          { ReactQueryDevtoolsPanel },
          { TanStackRouterDevtoolsPanel },
          { aiDevtoolsPlugin },
        ] = await Promise.all([
          import('@tanstack/react-devtools'),
          import('@tanstack/react-query-devtools'),
          import('@tanstack/react-router-devtools'),
          import('@tanstack/react-ai-devtools'),
        ]);

        return {
          default: () => (
            <TanStackDevtools
              plugins={[
                {
                  name: 'TanStack Query',
                  render: <ReactQueryDevtoolsPanel />,
                  defaultOpen: true,
                },
                {
                  name: 'TanStack Router',
                  render: <TanStackRouterDevtoolsPanel />,
                  defaultOpen: false,
                },
                aiDevtoolsPlugin(),
              ]}
            />
          ),
        };
      })
    : () => null;

type ProvidersProps = {
  children: React.ReactNode;
  queryClient: QueryClient;
};

const ObservabilityProvider: FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const posthogToken =
    process.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN ||
    import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;
  const apiHost =
    process.env.VITE_PUBLIC_POSTHOG_HOST ||
    import.meta.env.VITE_PUBLIC_POSTHOG_HOST ||
    'https://us.posthog.com';

  if (!posthogToken || !apiHost) {
    return children;
  }
  return (
    <PostHogProvider
      apiKey={posthogToken}
      options={{
        api_host: apiHost,
        defaults: '2025-05-24',
        capture_exceptions: true,
        debug: false,
      }}
    >
      {children}
    </PostHogProvider>
  );
};

export function Providers({ children, queryClient }: ProvidersProps) {
  return (
    <ObservabilityProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <PostHogIdentify />
          <RealtimeProvider
            api={{ url: '/api/realtime' }}
            maxReconnectAttempts={10}
          >
            {children}
          </RealtimeProvider>
          <TanStackDevtoolsLazy />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ObservabilityProvider>
  );
}
