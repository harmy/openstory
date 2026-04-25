import { AddLocationDialog } from '@/components/location-library/add-location-dialog';
import { LocationLibraryFilters } from '@/components/location-library/location-library-filters';
import { LocationLibraryList } from '@/components/location-library/location-library-list';
import { PageContainer } from '@/components/layout/page-container';
import { PageDescription } from '@/components/typography/page-description';
import { PageHeader } from '@/components/typography/page-header';
import { EmptyState } from '@/components/ui/empty-state';
import { useLibraryLocations } from '@/hooks/use-sequence-locations';
import { createFileRoute } from '@tanstack/react-router';
import { MapPin } from 'lucide-react';
import { z } from 'zod';

const searchParamsSchema = z.object({
  search: z.string().optional(),
});

export const Route = createFileRoute('/_protected/locations/')({
  validateSearch: searchParamsSchema,
  component: LocationsPage,
  staticData: { breadcrumb: 'Locations' },
});

function LocationsPage() {
  const { search } = Route.useSearch();
  const { data: locations, isLoading, error } = useLibraryLocations();

  // Filter locations based on search params
  const filteredLocations = locations?.filter((loc) => {
    // Filter by search query
    if (search) {
      const query = search.toLowerCase();
      return (
        loc.name.toLowerCase().includes(query) ||
        loc.description?.toLowerCase().includes(query)
      );
    }

    return true;
  });

  return (
    <div className="h-full overflow-auto">
      <PageContainer>
        <h1 className="sr-only">Location Library</h1>
        <PageHeader actions={<AddLocationDialog />}>
          <PageDescription>
            Browse and manage location references across all your sequences.
            Upload custom references to maintain visual consistency.
          </PageDescription>
        </PageHeader>

        <LocationLibraryFilters currentSearch={search} />

        {!isLoading && filteredLocations && filteredLocations.length === 0 ? (
          <EmptyState
            icon={<MapPin className="h-12 w-12" />}
            title="No locations yet"
            description="Add locations to your library to maintain visual consistency across your sequences."
            action={<AddLocationDialog />}
          />
        ) : (
          <LocationLibraryList
            locations={filteredLocations}
            isLoading={isLoading}
            error={error}
          />
        )}
      </PageContainer>
    </div>
  );
}
