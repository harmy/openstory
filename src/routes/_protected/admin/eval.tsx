import { EvalView } from '@/components/eval/eval-view';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const searchSchema = z.object({
  user: z.string().email().optional(),
});

export const Route = createFileRoute('/_protected/admin/eval')({
  validateSearch: searchSchema,
  component: EvalPage,
});

function EvalPage() {
  const { user } = Route.useSearch();
  return <EvalView initialUserFilter={user} />;
}
