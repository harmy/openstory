import { SheetStalenessBanners } from '@/components/sheets/sheet-staleness-banners';
import { Card } from '@/components/ui/card';
import type { LibraryLocation } from '@/lib/db/schema';
import { cn } from '@/lib/utils';
import { Loader2, MapPin } from 'lucide-react';

type LocationLibraryCardProps = {
  location: LibraryLocation;
  isGenerating?: boolean;
  onClick?: () => void;
  divergentVariantId?: string;
};

export const LocationLibraryCard: React.FC<LocationLibraryCardProps> = ({
  location,
  isGenerating = false,
  onClick,
  divergentVariantId,
}) => {
  const previewUrl = location.referenceImageUrl;

  return (
    <Card
      className="group relative overflow-hidden cursor-pointer hover:shadow-lg transition-shadow"
      onClick={onClick}
    >
      {/* Preview image - 16:9 aspect ratio for locations */}
      <div className="aspect-video bg-muted relative">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={location.name}
            className={cn(
              'w-full h-full object-cover',
              isGenerating && 'opacity-50'
            )}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <MapPin className="h-12 w-12 text-muted-foreground/30" />
          </div>
        )}

        {/* Generating overlay */}
        {isGenerating && (
          <div className="absolute inset-0 bg-background/60 backdrop-blur-sm flex items-center justify-center">
            <div className="flex flex-col items-center gap-2">
              <Loader2 className="h-8 w-8 animate-spin text-primary" />
              <span className="text-xs font-medium">Generating sheet…</span>
            </div>
          </div>
        )}

        {/* System badge */}
        {location.isPublic && (
          <div className="absolute top-2 left-2 rounded bg-background/80 px-2 py-1 text-xs font-medium text-muted-foreground backdrop-blur-sm">
            System
          </div>
        )}

        {divergentVariantId && (
          <div
            className="absolute right-2 top-2 z-10"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <SheetStalenessBanners
              density="corner-dot"
              entityType="library-location"
              divergentVariantId={divergentVariantId}
            />
          </div>
        )}
      </div>

      {/* Info section */}
      <div className="p-4">
        <h3 className="font-semibold text-sm line-clamp-1 mb-1">
          {location.name}
        </h3>

        {location.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">
            {location.description}
          </p>
        )}
      </div>
    </Card>
  );
};
