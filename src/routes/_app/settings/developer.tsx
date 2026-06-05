/**
 * Developer API Settings Page
 * Manage keys used to authenticate calls to the public OpenStory API.
 */

import { DeveloperApiKeySettings } from '@/components/settings/developer-api-key-settings';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_app/settings/developer')({
  component: DeveloperPage,
  staticData: { breadcrumb: 'Developer' },
});

function DeveloperPage() {
  return <DeveloperApiKeySettings />;
}
