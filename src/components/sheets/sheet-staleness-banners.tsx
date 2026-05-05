import { DivergentAlternateBanner } from '@/components/staleness/divergent-alternate-banner';
import { StalenessIndicator } from '@/components/staleness/staleness-indicator';
import type {
  StalenessEntityType,
  StalenessIndicatorDensity,
} from '@/components/staleness/staleness-indicator';

type SheetEntityType = Exclude<StalenessEntityType, 'frame' | 'sequence'>;

type SheetStalenessBannersProps = {
  entityType: SheetEntityType;
  /**
   * Active divergent variant id when one exists; takes precedence over the
   * staleness indicator. The doc rationale is that a divergent alternate is
   * generated from the inputs that are now live, so promoting it resolves
   * staleness automatically — surfacing both at once would crowd the panel.
   */
  divergentVariantId?: string;
  /** Whether the live primary's input hash has drifted from the current state. */
  isStale?: boolean;
  density?: StalenessIndicatorDensity;
  onCompareDivergent?: () => void;
  onPromoteDivergent?: () => void;
  onDiscardDivergent?: () => void;
  onRegenerate?: () => void;
  className?: string;
};

/**
 * Sheet-shaped sibling of `frame-staleness-banners.tsx`. Same precedence
 * rules: divergent banner wins, staleness indicator otherwise. Stage 2 ships
 * the divergent path; the staleness path is wired but currently a no-op for
 * sheet entities since the live-hash recompute server fns aren't part of v1.
 */
export const SheetStalenessBanners: React.FC<SheetStalenessBannersProps> = ({
  entityType,
  divergentVariantId,
  isStale = false,
  density = 'inline',
  onCompareDivergent,
  onPromoteDivergent,
  onDiscardDivergent,
  onRegenerate,
  className,
}) => {
  if (divergentVariantId) {
    return (
      <DivergentAlternateBanner
        density={density}
        variantId={divergentVariantId}
        artifact="sheet"
        entityType={entityType}
        onCompare={() => onCompareDivergent?.()}
        // Compare-only entry from the corner; promote/discard live in the dialog.
        onPromote={() =>
          density === 'corner-dot'
            ? onCompareDivergent?.()
            : onPromoteDivergent?.()
        }
        onDiscard={() =>
          density === 'corner-dot'
            ? onCompareDivergent?.()
            : onDiscardDivergent?.()
        }
        className={className}
      />
    );
  }

  if (isStale && onRegenerate) {
    return (
      <StalenessIndicator
        artifact="sheet"
        entityType={entityType}
        density={density}
        onRegenerate={onRegenerate}
        className={className}
      />
    );
  }

  return null;
};
