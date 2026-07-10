import { PageContainer } from '@/components/layout/page-container';
import { PageDescription } from '@/components/typography/page-description';
import { PageHeader } from '@/components/typography/page-header';
import { CATALOG_ACTIVITIES } from '@/lib/models/catalog';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ArrowLeft } from 'lucide-react';
import { z } from 'zod';

// Splat route: fal endpoint ids contain slashes (`fal-ai/flux-1/dev`), so the
// whole id is the `_splat`. The activity travels as a search param — the
// schema API needs both to locate the model.
const searchParamsSchema = z.object({
  activity: z.enum(CATALOG_ACTIVITIES).optional(),
});

export const Route = createFileRoute('/_app/models/$')({
  validateSearch: searchParamsSchema,
  component: ModelDetailPage,
  staticData: { breadcrumb: 'Model' },
});

/**
 * Placeholder detail page (#458 phase 1): establishes the splat route so
 * catalog cards have real, typed hrefs. Phase 2 replaces this component with
 * the schema-driven parameter form + run/poll/result loop.
 */
function ModelDetailPage() {
  const { _splat: endpointId } = Route.useParams();

  return (
    <div className="h-full overflow-auto">
      <PageContainer>
        <PageHeader>
          <h1 className="text-2xl font-semibold tracking-tight">
            {endpointId}
          </h1>
          <PageDescription>
            The parameter form and runner for this model are on their way.
          </PageDescription>
        </PageHeader>
        <Link
          to="/models"
          className="flex w-fit items-center gap-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft aria-hidden="true" className="size-4" />
          Back to models
        </Link>
      </PageContainer>
    </div>
  );
}
