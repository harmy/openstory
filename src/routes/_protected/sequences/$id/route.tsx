import { RouteErrorFallback } from '@/components/error/route-error-fallback';
import {
  ImageModelBadge,
  ModelBadge,
  MusicModelBadge,
  VideoModelBadge,
} from '@/components/model/model-badge';
import { getSequenceImageModelsFn } from '@/functions/frames';
import { frameKeys } from '@/hooks/use-frames';
import {
  SequenceTabs,
  useSequenceTabItems,
} from '@/components/sequence/sequence-tabs';
import { PageHeader } from '@/components/typography/page-header';
import { PageHeading } from '@/components/typography/page-heading';
import { getSequenceFn } from '@/functions/sequences';
import { sequenceKeys, useSequence } from '@/hooks/use-sequences';
import { useSwipeNavigation } from '@/hooks/use-swipe-navigation';
import { useUser } from '@/hooks/use-user';
import { isValidId } from '@/lib/db/id';
import { useQuery } from '@tanstack/react-query';
import {
  createFileRoute,
  isNotFound,
  notFound,
  Outlet,
  useRouterState,
} from '@tanstack/react-router';

export const Route = createFileRoute('/_protected/sequences/$id')({
  component: SequenceLayout,
  loader: async ({ params, context: { queryClient } }) => {
    if (!isValidId(params.id)) {
      throw notFound();
    }

    try {
      const sequence = await queryClient.ensureQueryData({
        queryKey: sequenceKeys.detail(params.id),
        queryFn: () => getSequenceFn({ data: { sequenceId: params.id } }),
      });
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!sequence) throw notFound();
    } catch (error) {
      if (isNotFound(error)) throw error;
      throw notFound();
    }
  },
  errorComponent: (props) => (
    <RouteErrorFallback {...props} heading="Sequence error" />
  ),
});

function SequenceLayout() {
  const { id: sequenceId } = Route.useParams();

  useUser();

  const { data: sequence } = useSequence(sequenceId);

  const { data: imageModels } = useQuery({
    queryKey: frameKeys.imageModels(sequenceId),
    queryFn: () => getSequenceImageModelsFn({ data: { sequenceId } }),
    staleTime: 30_000,
  });

  const tabs = useSequenceTabItems(sequenceId);
  const currentPath = useRouterState({
    select: (s) => s.location.pathname,
  });
  const { onTouchStart, onTouchEnd } = useSwipeNavigation({
    routes: tabs.map((t) => t.href),
    currentRoute: currentPath,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto w-full max-w-[1920px] shrink-0 space-y-1 px-6 pt-4">
        <PageHeader>
          <PageHeading>{sequence?.title}</PageHeading>
          <div className="hidden md:flex flex-row flex-wrap items-center gap-2">
            <ModelBadge model={sequence?.analysisModel} />
            <ImageModelBadge
              models={imageModels}
              model={sequence?.imageModel}
            />
            <VideoModelBadge model={sequence?.videoModel} />
            <MusicModelBadge model={sequence?.musicModel ?? undefined} />
          </div>
        </PageHeader>
        <SequenceTabs sequenceId={sequenceId} />
      </div>
      <div
        className="mx-auto w-full max-w-[1920px] flex-1 min-h-0 overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <Outlet />
      </div>
    </div>
  );
}
