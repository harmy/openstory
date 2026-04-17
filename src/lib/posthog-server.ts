import { PostHog } from 'posthog-node';

let posthogClient: PostHog | null = null;

export function getPostHogClient(): PostHog | null {
  if (!posthogClient) {
    const projectToken =
      process.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN ||
      import.meta.env.VITE_PUBLIC_POSTHOG_PROJECT_TOKEN;

    if (!projectToken) {
      // Gracefully return null if PostHog is not configured
      console.warn('PostHog is not configured');
      return null;
    }
    posthogClient = new PostHog(projectToken, {
      host:
        process.env.VITE_PUBLIC_POSTHOG_HOST ||
        import.meta.env.VITE_PUBLIC_POSTHOG_HOST ||
        'https://us.i.posthog.com',
      flushAt: 1,
      flushInterval: 0,
    });
  }
  return posthogClient;
}
