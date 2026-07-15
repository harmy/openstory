import { Badge } from '@/components/ui/badge';
import type { FC } from 'react';

const THIRTY_DAYS_S = 30 * 24 * 60 * 60;

/**
 * Release marker for catalog tiles: "New" for models first seen within the
 * last month, a short month-year date otherwise. `firstSeenAt` is mostly the
 * modelschemas tracking epoch today, so back-catalog dates read as Jun 2026
 * until release dates are backdated upstream.
 */
export const ReleaseBadge: FC<{
  /** Epoch seconds (`firstSeenAt` / family `releasedAt`); renders nothing when absent. */
  releasedAt: number | null | undefined;
}> = ({ releasedAt }) => {
  if (!releasedAt) return null;
  if (Date.now() / 1000 - releasedAt < THIRTY_DAYS_S) {
    return <Badge>New</Badge>;
  }
  return (
    <span className="text-xs text-muted-foreground">
      {new Date(releasedAt * 1000).toLocaleDateString('en-US', {
        month: 'short',
        year: 'numeric',
      })}
    </span>
  );
};
