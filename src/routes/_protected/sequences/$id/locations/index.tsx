import { LocationView } from '@/components/locations/location-view';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_protected/sequences/$id/locations/')({
  component: LocationsPage,
  staticData: { breadcrumb: 'Locations' },
});

function LocationsPage() {
  const { id: sequenceId } = Route.useParams();

  return <LocationView sequenceId={sequenceId} />;
}
