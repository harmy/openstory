import { Info } from 'lucide-react';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  StalenessArtifact,
  StalenessEntityType,
  StalenessIndicatorDensity,
} from './staleness-indicator';

type DivergentAlternateBannerProps = {
  variantId: string;
  artifact: StalenessArtifact;
  entityType: StalenessEntityType;
  onCompare: () => void;
  onPromote: () => void;
  onDiscard: () => void;
  density?: StalenessIndicatorDensity;
  className?: string;
};

const ARTIFACT_LABEL: Record<StalenessArtifact, string> = {
  thumbnail: 'image',
  video: 'video',
  audio: 'audio',
  sheet: 'sheet',
  'visual-prompt': 'visual prompt',
  'motion-prompt': 'motion prompt',
  'music-prompt': 'music prompt',
};

export const DivergentAlternateBanner: React.FC<
  DivergentAlternateBannerProps
> = ({
  variantId,
  artifact,
  entityType,
  onCompare,
  onPromote,
  onDiscard,
  density = 'inline',
  className,
}) => {
  const ariaLabel = `Divergent alternate ${ARTIFACT_LABEL[artifact]} available for this ${entityType}`;

  if (density === 'corner-dot') {
    return (
      <button
        type="button"
        onClick={onCompare}
        aria-label={ariaLabel}
        title="Alternate version available — click to compare"
        data-slot="divergent-alternate-dot"
        data-variant-id={variantId}
        data-artifact={artifact}
        data-entity-type={entityType}
        className={cn(
          'group relative inline-flex h-6 w-6 items-center justify-center rounded-full',
          'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
          className
        )}
      >
        <span
          aria-hidden="true"
          className="block h-2 w-2 rounded-full bg-sky-500 ring-2 ring-sky-500/30 transition-transform group-hover:scale-110 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        />
      </button>
    );
  }

  return (
    <Alert
      role="status"
      aria-live="polite"
      data-slot="divergent-alternate-banner"
      data-density="inline"
      data-variant-id={variantId}
      data-artifact={artifact}
      data-entity-type={entityType}
      className={className}
    >
      <Info aria-hidden="true" />
      <AlertTitle>Alternate version available</AlertTitle>
      <AlertDescription>
        An alternate {ARTIFACT_LABEL[artifact]} was generated with the inputs
        you had at the time.
      </AlertDescription>
      <AlertAction className="flex items-center gap-1">
        <Button type="button" size="sm" variant="outline" onClick={onCompare}>
          Compare
        </Button>
        <Button type="button" size="sm" onClick={onPromote}>
          Promote
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDiscard}>
          Discard
        </Button>
      </AlertAction>
    </Alert>
  );
};
