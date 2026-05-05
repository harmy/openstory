import { SheetStalenessBanners } from '@/components/sheets/sheet-staleness-banners';
import { Card } from '@/components/ui/card';
import type { SequenceLocation } from '@/lib/db/schema';
import { MapPin, Sparkles } from 'lucide-react';

type LocationCardProps = {
  location: SequenceLocation;
  divergentVariantId?: string;
};

export const LocationCard: React.FC<LocationCardProps> = ({
  location,
  divergentVariantId,
}) => {
  const imageUrl = location.referenceImageUrl;

  return (
    <Card className="group relative cursor-pointer overflow-hidden transition-all duration-200 hover:ring-2 hover:ring-primary/50">
      {/* Location reference image - 16:9 aspect ratio */}
      <div className="aspect-video bg-muted relative">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={location.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <MapPin className="h-16 w-16 text-muted-foreground/30" />
          </div>
        )}

        {/* Gradient overlay on hover */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />

        {/* Reference status indicator */}
        {location.referenceStatus === 'generating' && (
          <div className="absolute right-2 top-2 rounded-full bg-primary/90 px-2 py-0.5 text-xs font-medium text-primary-foreground">
            Generating…
          </div>
        )}

        {divergentVariantId && (
          <div
            className="absolute right-2 bottom-2 z-10"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <SheetStalenessBanners
              density="corner-dot"
              entityType="location"
              divergentVariantId={divergentVariantId}
            />
          </div>
        )}

        {/* Location type badge */}
        {location.type && (
          <div className="absolute left-2 top-2 rounded-full bg-black/60 px-2 py-0.5 text-xs font-medium text-white">
            {location.type === 'interior'
              ? 'INT'
              : location.type === 'exterior'
                ? 'EXT'
                : 'INT/EXT'}
          </div>
        )}
      </div>

      {/* Location name and info */}
      <div className="p-3">
        <h3 className="truncate text-sm font-medium">{location.name}</h3>
        <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
          <Sparkles className="h-3 w-3 flex-shrink-0" />
          <span className="truncate">
            {location.timeOfDay || 'Auto-generated'}
          </span>
        </p>
      </div>
    </Card>
  );
};
