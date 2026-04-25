import { TheatreView } from '@/components/theatre/theatre-view';
import { Skeleton } from '@/components/ui/skeleton';
import { useSequence } from '@/hooks/use-sequences';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_protected/sequences/$id/theatre')({
  component: TheatrePage,
  staticData: { breadcrumb: 'Theatre' },
});

// Constrain player to fit viewport. Header+tabs ≈ 10rem, so available ≈ 100dvh - 11rem.
// Full class names required for Tailwind JIT to detect at build time.
const THEATRE_MAX_CLASS_BY_RATIO: Record<AspectRatio, string> = {
  '16:9': 'w-full max-h-[calc(100dvh-15rem)] max-w-4xl',
  '9:16':
    'w-full max-h-[calc(100dvh-15rem)] max-w-[calc((100dvh-15rem)*0.5625)]',
  '1:1': 'w-full max-h-[calc(100dvh-15rem)] max-w-[calc(100dvh-15rem)]',
};

function TheatrePage() {
  const { id: sequenceId } = Route.useParams();

  const { data: sequence, isLoading } = useSequence(sequenceId, {
    refetchInterval: (query) => {
      if (query.state.data?.mergedVideoStatus === 'merging') return 2000;
      return false;
    },
  });

  if (isLoading || !sequence) {
    return (
      <div className="flex-1 p-4">
        <Skeleton className="aspect-video w-full max-w-4xl mx-auto" />
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className={THEATRE_MAX_CLASS_BY_RATIO[sequence.aspectRatio]}>
        <TheatreView sequence={sequence} />
      </div>
    </div>
  );
}
