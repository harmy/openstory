import { VideoIcon } from '@/components/icons/video-icon';
import { PageContainer } from '@/components/layout/page-container';
import { PageDescription } from '@/components/typography/page-description';
import { PageHeader } from '@/components/typography/page-header';
import { PageHeading } from '@/components/typography/page-heading';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SequencesList } from '@/components/sequence/sequences-list';
import { sequenceKeys, useSequences } from '@/hooks/use-sequences';
import { getSequencesFn } from '@/functions/sequences';
import { Route as sequencesNewRoute } from '@/routes/_protected/sequences/new';
import { createFileRoute, Link } from '@tanstack/react-router';

export const Route = createFileRoute('/_protected/sequences/')({
  component: SequencesPage,
  beforeLoad: async ({ context: { queryClient } }) => {
    await queryClient.ensureQueryData({
      queryKey: sequenceKeys.list(),
      queryFn: () => getSequencesFn(),
      staleTime: 5 * 60 * 1000,
    });
  },
});

function SequencesPage() {
  const { data: sequences, isLoading } = useSequences();

  return (
    <div className="h-full overflow-auto">
      <PageContainer>
        <PageHeader
          actions={
            <Button asChild>
              <Link to={sequencesNewRoute.fullPath}>Create New Sequence</Link>
            </Button>
          }
        >
          <PageHeading>Your Sequences</PageHeading>
          <PageDescription>
            Manage and view all your video sequences in one place.
          </PageDescription>
        </PageHeader>

        {!isLoading && sequences && sequences.length === 0 ? (
          <EmptyState
            icon={<VideoIcon size="xl" />}
            title="No sequences yet"
            description="Get started by creating your first video sequence. Transform your script into professional video content with AI assistance."
            action={
              <Button asChild size="lg">
                <Link to={sequencesNewRoute.fullPath}>
                  Create Your First Sequence
                </Link>
              </Button>
            }
          />
        ) : (
          <SequencesList />
        )}
      </PageContainer>
    </div>
  );
}
