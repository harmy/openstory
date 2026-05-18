import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { DivergentAlternateBanner } from '@/components/staleness/divergent-alternate-banner';
import { StalenessIndicator } from '@/components/staleness/staleness-indicator';
import { getSequenceImageVariantsFn } from '@/functions/frames';
import { useFrameStaleness } from '@/hooks/use-frame-staleness';
import type { FrameVariant } from '@/lib/db/schema';

type FrameStalenessBannersProps = {
  frameId?: string;
  sequenceId: string;
  onRegenerate: () => void;
  onCompareDivergent?: (variantId: string) => void;
  onPromoteDivergent?: (variantId: string) => void;
  onDiscardDivergent?: (variantId: string) => void;
};

/**
 * Surfaces Stage 1 divergence + staleness signals for the currently selected
 * frame. The divergent banner is driven by `frame_variants` rows with
 * `divergedAt IS NOT NULL` (refreshed in real time by `stale:detected`); the
 * staleness indicator queries the scoped `isStale` helper. Both render at most
 * once per frame so the panel stays calm — only the most recent divergent
 * alternate is offered.
 *
 * Compare/promote/discard handlers are intentionally optional: this PR ships
 * the surfacing primitive; the variant resolution UI lands in a follow-up.
 */
export const FrameStalenessBanners: React.FC<FrameStalenessBannersProps> = ({
  frameId,
  sequenceId,
  onRegenerate,
  onCompareDivergent,
  onPromoteDivergent,
  onDiscardDivergent,
}) => {
  const { data: staleness } = useFrameStaleness({ sequenceId, frameId });

  // Same key as `scenes-view`; sharing it means the cache invalidation fired
  // by `stale:detected` reaches both the variant grid and this banner with one
  // refetch.
  const { data: variants } = useQuery<FrameVariant[]>({
    queryKey: ['sequence-image-variants', sequenceId],
    queryFn: () => getSequenceImageVariantsFn({ data: { sequenceId } }),
    enabled: !!sequenceId && !!frameId,
    staleTime: 30_000,
  });

  const latestDivergent = useMemo(() => {
    if (!frameId || !variants) return undefined;
    return variants
      .filter(
        (v) =>
          v.frameId === frameId &&
          v.variantType === 'image' &&
          v.divergedAt !== null
      )
      .sort(
        (a, b) =>
          (b.divergedAt?.getTime() ?? 0) - (a.divergedAt?.getTime() ?? 0)
      )[0];
  }, [variants, frameId]);

  if (!frameId) return null;

  // Divergent alternate takes precedence: a brand-new alternate is a more
  // actionable signal than a generic "inputs changed" hint, and showing both
  // at once would crowd the panel header.
  if (latestDivergent) {
    return (
      <DivergentAlternateBanner
        variantId={latestDivergent.id}
        artifact="thumbnail"
        entityType="frame"
        onCompare={() => onCompareDivergent?.(latestDivergent.id)}
        onPromote={
          onPromoteDivergent
            ? () => onPromoteDivergent(latestDivergent.id)
            : undefined
        }
        onDiscard={
          onDiscardDivergent
            ? () => onDiscardDivergent(latestDivergent.id)
            : undefined
        }
      />
    );
  }

  // Suppress the thumbnail banner when the visual prompt is also stale: the
  // visual-prompt banner inside the Image tab is the prerequisite action
  // (regenerating the image from a stale prompt would just produce another
  // stale image), and showing both at once is redundant.
  if (staleness?.thumbnail === 'stale' && staleness.visualPrompt !== 'stale') {
    return (
      <StalenessIndicator
        artifact="thumbnail"
        entityType="frame"
        onRegenerate={onRegenerate}
      />
    );
  }

  return null;
};
