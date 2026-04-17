import { useUser } from '@/hooks/use-user';
import { usePostHog } from '@posthog/react';
import { useEffect, useRef } from 'react';

/**
 * Identifies the authenticated user in PostHog using their stable userId.
 * Automatically resets on logout. Mount inside PostHogProvider.
 */
export const PostHogIdentify: React.FC = () => {
  const posthog = usePostHog();
  const { data: user } = useUser();
  const identifiedRef = useRef<string | null>(null);

  useEffect(() => {
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard: posthog is undefined when VITE_PUBLIC_POSTHOG_PROJECT_TOKEN is unset
    if (!posthog) return;

    if (user && identifiedRef.current !== user.id) {
      posthog.identify(user.id, {
        email: user.email,
        name: user.name,
      });
      identifiedRef.current = user.id;
    } else if (!user && identifiedRef.current) {
      posthog.reset();
      identifiedRef.current = null;
    }
  }, [posthog, user]);

  return null;
};
