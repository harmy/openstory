import { createFileRoute, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_marketing/')({
  beforeLoad: async () => {
    // The app itself is the front page: everyone — logged in or not — lands
    // directly in the new-sequence composer. Anonymous visitors can compose
    // freely; actions prompt a login (see AuthGateProvider).
    //
    // The old marketing sections that rendered here are gone. The crawlable
    // content they carried lives on at /docs/faq (FAQ + structured data) and
    // llms.txt (#814).
    throw redirect({ to: '/sequences/new' });
  },
});
