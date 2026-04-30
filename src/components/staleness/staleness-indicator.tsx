import { useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export type StalenessArtifact =
  | 'thumbnail'
  | 'video'
  | 'audio'
  | 'sheet'
  | 'visual-prompt'
  | 'motion-prompt'
  | 'music-prompt';

export type StalenessEntityType =
  | 'frame'
  | 'character'
  | 'location'
  | 'library-location'
  | 'talent'
  | 'sequence';

export type StalenessIndicatorDensity = 'inline' | 'corner-dot';

type StalenessIndicatorProps = {
  artifact: StalenessArtifact;
  entityType: StalenessEntityType;
  onRegenerate: () => void;
  onDismiss?: () => void;
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

export const StalenessIndicator: React.FC<StalenessIndicatorProps> = ({
  artifact,
  entityType,
  onRegenerate,
  onDismiss,
  density = 'inline',
  className,
}) => {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  const handleDismiss = () => {
    setDismissed(true);
    onDismiss?.();
  };

  const ariaLabel = `Stale ${ARTIFACT_LABEL[artifact]} on this ${entityType} — inputs changed since it was generated`;

  if (density === 'corner-dot') {
    return (
      <button
        type="button"
        onClick={onRegenerate}
        aria-label={ariaLabel}
        title="Inputs changed — click to regenerate"
        data-slot="staleness-indicator-dot"
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
          className="block h-2 w-2 rounded-full bg-amber-500 ring-2 ring-amber-500/30 transition-transform group-hover:scale-110 motion-reduce:transition-none motion-reduce:group-hover:scale-100"
        />
      </button>
    );
  }

  return (
    <Alert
      data-slot="staleness-indicator"
      data-density="inline"
      data-artifact={artifact}
      data-entity-type={entityType}
      className={cn(
        'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-50',
        className
      )}
    >
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>Inputs changed</AlertTitle>
      <AlertDescription>
        This {ARTIFACT_LABEL[artifact]} was generated from earlier inputs.
      </AlertDescription>
      <AlertAction className="flex items-center gap-1">
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onRegenerate}
        >
          Regenerate
        </Button>
        {onDismiss && (
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={handleDismiss}
            aria-label="Dismiss staleness indicator"
          >
            <X aria-hidden="true" />
          </Button>
        )}
      </AlertAction>
    </Alert>
  );
};
