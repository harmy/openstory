/**
 * API Keys Settings Page
 * Manage BYOK (Bring Your Own Key) for AI providers
 */

import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { ApiKeySettings } from '@/components/settings/api-key-settings';

const searchSchema = z.object({
  success: z.string().optional(),
  error: z.string().optional(),
});

export const Route = createFileRoute('/_protected/settings/api-keys')({
  validateSearch: searchSchema,
  component: ApiKeysPage,
  staticData: { breadcrumb: 'API Keys' },
});

function ApiKeysPage() {
  const { success, error } = Route.useSearch();

  return <ApiKeySettings success={success} error={error} />;
}
