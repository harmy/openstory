/**
 * BetterAuth client configuration for React components
 * Provides client-side authentication methods and hooks
 */

import { passkeyClient } from '@better-auth/passkey/client';
import {
  emailOTPClient,
  inferAdditionalFields,
  lastLoginMethodClient,
} from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/react';
import { getQueryClient } from '../query-client';
import type { Auth } from './config';

/** Auth API paths that change session state */
const SESSION_MUTATION_PATHS = [
  '/sign-in/',
  '/sign-up/',
  '/sign-out',
  '/organization/set-active',
];

// Create the auth client
export const authClient = createAuthClient({
  fetchOptions: {
    onSuccess(context) {
      const path = new URL(context.response.url).pathname;
      const isSessionMutation = SESSION_MUTATION_PATHS.some((p) =>
        path.includes(p)
      );
      if (!isSessionMutation) return;
      // When session is mutated, clear the query client to avoid stale data
      const queryClient = getQueryClient();
      queryClient.clear();
    },
  },
  plugins: [
    emailOTPClient(),
    passkeyClient(),
    inferAdditionalFields<Auth>(),
    lastLoginMethodClient(),
  ],
});

// Export hooks and methods for easy use
export const {
  useSession,

  // useListSessions,
} = authClient;
