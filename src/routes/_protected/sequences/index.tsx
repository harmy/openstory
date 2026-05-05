import { EvalView } from '@/components/eval/eval-view';
import { PageContainer } from '@/components/layout/page-container';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const searchSchema = z.object({
  user: z.string().email().optional(),
});

export const Route = createFileRoute('/_protected/sequences/')({
  validateSearch: searchSchema,
  component: SequencesPage,
  staticData: { breadcrumb: 'Sequences' },
});

function SequencesPage() {
  const { user } = Route.useSearch();
  return (
    <PageContainer
      maxWidth="full"
      padding="compact"
      className="flex-1 flex flex-col overflow-hidden"
    >
      <h1 className="sr-only">Your Sequences</h1>
      <EvalView initialUserFilter={user} />
    </PageContainer>
  );
}
