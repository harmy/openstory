import { SheetStalenessBanners } from '@/components/sheets/sheet-staleness-banners';
import { Card } from '@/components/ui/card';
import type { CharacterWithTalent } from '@/lib/db/schema';
import { Sparkles, User } from 'lucide-react';

type TalentCardProps = {
  character: CharacterWithTalent;
  divergentVariantId?: string;
};

export const TalentCard: React.FC<TalentCardProps> = ({
  character,
  divergentVariantId,
}) => {
  const imageUrl = character.sheetImageUrl;

  return (
    <Card className="group relative cursor-pointer overflow-hidden transition-all duration-200 hover:ring-2 hover:ring-primary/50">
      {/* Character avatar - cropped from right side of sheet where large headshot lives */}
      <div className="aspect-square bg-muted relative">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={character.name}
            className="h-full w-full object-cover"
            style={{
              // The character sheet is 16:9 with a large headshot on the right side
              // Crop to the right ~25% and lower ~60% where the headshot panel is
              objectPosition: '95% 75%',
            }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <User className="h-16 w-16 text-muted-foreground/30" />
          </div>
        )}

        {/* Gradient overlay on hover */}
        <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent opacity-0 transition-opacity duration-200 group-hover:opacity-100" />

        {/* Sheet status indicator */}
        {character.sheetStatus === 'generating' && (
          <div className="absolute right-2 top-2 rounded-full bg-primary/90 px-2 py-0.5 text-xs font-medium text-primary-foreground">
            Generating…
          </div>
        )}

        {divergentVariantId && (
          <div
            className="absolute left-2 top-2 z-10"
            // Stop click bubbling so the dot's own click handler (jump to detail
            // view via the parent's `onClick`) can fire without re-selecting
            // the card behind it.
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
            role="presentation"
          >
            <SheetStalenessBanners
              density="corner-dot"
              entityType="character"
              divergentVariantId={divergentVariantId}
            />
          </div>
        )}
      </div>

      {/* Character name and talent info */}
      <div className="p-3">
        <h3 className="truncate text-sm font-medium">{character.name}</h3>
        {character.talent ? (
          <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
            <User className="h-3 w-3 flex-shrink-0" />
            <span className="truncate">{character.talent.name}</span>
          </p>
        ) : (
          <p className="mt-0.5 flex items-center gap-1 truncate text-xs text-muted-foreground">
            <Sparkles className="h-3 w-3 flex-shrink-0" />
            <span>Auto-generated</span>
          </p>
        )}
      </div>
    </Card>
  );
};
