import { createFileRoute } from '@tanstack/react-router';
import { OgImageGitHub } from '@/components/marketing/og-image-github';

export const Route = createFileRoute('/meta/og-github')({
  component: OgImageGitHub,
});
