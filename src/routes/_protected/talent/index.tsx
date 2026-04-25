import { AddTalentDialog } from '@/components/talent-library/add-talent-dialog';
import { TalentLibraryFilters } from '@/components/talent-library/talent-library-filters';
import { TalentLibraryList } from '@/components/talent-library/talent-library-list';
import { PageContainer } from '@/components/layout/page-container';
import { PageDescription } from '@/components/typography/page-description';
import { PageHeader } from '@/components/typography/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { useTalent } from '@/hooks/use-talent';
import { createFileRoute } from '@tanstack/react-router';
import { User } from 'lucide-react';
import { z } from 'zod';

const searchParamsSchema = z.object({
  filter: z.enum(['all', 'favorites']).optional().default('all'),
});

export const Route = createFileRoute('/_protected/talent/')({
  validateSearch: searchParamsSchema,
  component: TalentPage,
  staticData: { breadcrumb: 'Talent' },
});

function TalentPage() {
  const { filter } = Route.useSearch();
  const {
    data: talent,
    isLoading,
    error,
  } = useTalent({
    favoritesOnly: filter === 'favorites',
  });

  return (
    <div className="h-full overflow-auto">
      <PageContainer>
        <h1 className="sr-only">Talent Library</h1>
        <PageHeader actions={<AddTalentDialog />}>
          <PageDescription>
            Manage your team's talent library for consistent AI-generated
            content.
          </PageDescription>
        </PageHeader>

        <TalentLibraryFilters currentFilter={filter} />

        {!isLoading && talent && talent.length === 0 ? (
          <EmptyState
            icon={<User className="h-12 w-12" />}
            title="No talent yet"
            description="Add talent to your library to maintain visual consistency across your sequences."
            action={<AddTalentDialog />}
          />
        ) : (
          <TalentLibraryList
            talent={talent}
            isLoading={isLoading}
            error={error}
          />
        )}
      </PageContainer>
    </div>
  );
}
