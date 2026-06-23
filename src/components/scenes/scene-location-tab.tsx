/**
 * Scene Location Tab
 * Displays the location for the current shot with reference image and details
 */

import { Skeleton } from '@/components/ui/skeleton';
import { useSequenceLocations } from '@/hooks/use-sequence-locations';
import type { SequenceLocation } from '@/lib/db/schema';
import type { Shot } from '@/types/database';
import { Link } from '@tanstack/react-router';
import { ExternalLink, MapPin } from 'lucide-react';

type SceneLocationTabProps = {
  shot?: Shot;
  sequenceId: string;
};

/**
 * Match a location to a shot's environmentTag
 * Replicates logic from sequence-locations.ts locationMatchesTag
 */
function locationMatchesTag(
  location: SequenceLocation,
  environmentTag: string
): boolean {
  if (!environmentTag) return false;

  const consistencyTag = (location.consistencyTag ?? '').toLowerCase();
  const locName = location.name.toLowerCase();
  const locId = location.locationId.toLowerCase();
  const envTagLower = environmentTag.toLowerCase();

  // Check if any of the location identifiers match the environment tag
  if (consistencyTag && envTagLower.includes(consistencyTag)) return true;
  if (envTagLower.includes(locName)) return true;
  if (envTagLower.includes(locId)) return true;

  // Also check if location name contains the env tag (reverse match)
  if (locName.includes(envTagLower)) return true;

  return false;
}

/**
 * Match location to shot's environmentTag or metadata.location
 */
function matchLocationToShot(
  locations: SequenceLocation[],
  shot: Shot
): SequenceLocation | null {
  const environmentTag = shot.metadata?.continuity?.environmentTag ?? '';
  const sceneLocation = shot.metadata?.metadata?.location ?? '';

  if (!environmentTag && !sceneLocation) return null;

  const match = locations.find((location) => {
    return (
      (environmentTag && locationMatchesTag(location, environmentTag)) ||
      (sceneLocation && locationMatchesTag(location, sceneLocation))
    );
  });

  return match ?? null;
}

type DetailRowProps = {
  label: string;
  value: string | null | undefined;
};

const DetailRow: React.FC<DetailRowProps> = ({ label, value }) => {
  if (!value) return null;

  return (
    <div className="space-y-1">
      <dt className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm leading-relaxed">{value}</dd>
    </div>
  );
};

export const SceneLocationTab: React.FC<SceneLocationTabProps> = ({
  shot,
  sequenceId,
}) => {
  const { data: locations, isLoading } = useSequenceLocations(sequenceId);

  // Match location to this shot
  const shotLocation =
    shot && locations ? matchLocationToShot(locations, shot) : null;

  // Loading state
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="aspect-video w-full rounded-lg" />
        <div className="space-y-3">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      </div>
    );
  }

  // Empty state - no location matched
  if (!shotLocation) {
    const environmentTag = shot?.metadata?.continuity?.environmentTag;
    const sceneLocation = shot?.metadata?.metadata?.location;

    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="mb-4 rounded-full bg-muted p-4">
          <MapPin className="h-8 w-8 text-muted-foreground/50" />
        </div>
        <p className="text-sm text-muted-foreground">
          No location for this scene
        </p>
        {(environmentTag || sceneLocation) && (
          <p className="mt-2 text-xs text-muted-foreground/70">
            Looking for: {environmentTag || sceneLocation}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Location header with link */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground">
          <span>Scene Location</span>
          {shotLocation.type && (
            <>
              <span className="text-muted-foreground/50">·</span>
              <span>
                {shotLocation.type === 'interior'
                  ? 'Interior'
                  : shotLocation.type === 'exterior'
                    ? 'Exterior'
                    : 'Int/Ext'}
              </span>
            </>
          )}
        </div>
        <Link
          to="/sequences/$id/locations/$locationId"
          params={{ id: sequenceId, locationId: shotLocation.id }}
          className="flex items-center gap-1 text-xs text-primary hover:underline"
        >
          View Details
          <ExternalLink className="h-3 w-3" />
        </Link>
      </div>

      {/* Reference image */}
      <div className="relative aspect-video overflow-hidden rounded-lg bg-muted">
        {shotLocation.referenceImageUrl ? (
          <img
            src={shotLocation.referenceImageUrl}
            alt={shotLocation.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2">
            <MapPin className="h-12 w-12 text-muted-foreground/20" />
            <p className="text-xs text-muted-foreground">
              {shotLocation.referenceStatus === 'generating'
                ? 'Generating reference…'
                : 'No reference image'}
            </p>
          </div>
        )}

        {/* Type badge overlay */}
        {shotLocation.type && shotLocation.referenceImageUrl && (
          <div className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
            {shotLocation.type === 'interior'
              ? 'INT'
              : shotLocation.type === 'exterior'
                ? 'EXT'
                : 'INT/EXT'}
          </div>
        )}
      </div>

      {/* Location name */}
      <h3 className="text-sm font-medium">{shotLocation.name}</h3>

      {/* Location details */}
      <dl className="space-y-3">
        <DetailRow label="Description" value={shotLocation.description} />
        <div className="grid grid-cols-2 gap-3">
          <DetailRow label="Time of Day" value={shotLocation.timeOfDay} />
          <DetailRow
            label="Architectural Style"
            value={shotLocation.architecturalStyle}
          />
        </div>
        <DetailRow label="Key Features" value={shotLocation.keyFeatures} />
        <div className="grid grid-cols-2 gap-3">
          <DetailRow label="Color Palette" value={shotLocation.colorPalette} />
          <DetailRow label="Lighting" value={shotLocation.lightingSetup} />
        </div>
        <DetailRow label="Ambiance" value={shotLocation.ambiance} />

        {/* Consistency tag */}
        {shotLocation.consistencyTag && (
          <div className="pt-2">
            <span className="rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
              {shotLocation.consistencyTag}
            </span>
          </div>
        )}
      </dl>
    </div>
  );
};
