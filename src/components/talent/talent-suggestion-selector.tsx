/**
 * Talent Suggestion Selector
 *
 * Multi-select component for suggesting talent during sequence creation.
 * Shows selected talent as avatars with a picker dialog for selection.
 */

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { useTalent } from '@/hooks/use-talent';
import type { TalentWithSheets } from '@/lib/db/schema';
import { cn } from '@/lib/utils';
import { Link } from '@tanstack/react-router';
import { Check, Search, User, Users, X } from 'lucide-react';
import { useState } from 'react';

type TalentSuggestionSelectorProps = {
  selectedTalentIds: string[];
  onSelectionChange: (ids: string[]) => void;
  disabled?: boolean;
};

type TalentPickerCardProps = {
  talent: TalentWithSheets;
  isSelected: boolean;
  onClick: () => void;
};

const TalentPickerCard: React.FC<TalentPickerCardProps> = ({
  talent,
  isSelected,
  onClick,
}) => {
  const sheet = talent.sheets.find((s) => s.isDefault) ?? talent.sheets[0];
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- sheet is undefined when sheets array is empty
  const imageUrl = sheet?.imageUrl ?? talent.imageUrl;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'group relative flex flex-col items-center gap-2 rounded-lg p-3 text-center transition-colors focus:outline-none focus:ring-2 focus:ring-primary',
        isSelected ? 'bg-primary/10 ring-2 ring-primary' : 'hover:bg-muted'
      )}
    >
      <div className="aspect-square w-full overflow-hidden rounded-lg bg-muted">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={talent.name}
            className="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105"
            style={{ objectPosition: '95% 75%' }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <User className="h-12 w-12 text-muted-foreground/30" />
          </div>
        )}
      </div>
      <span className="text-sm font-medium truncate w-full">{talent.name}</span>
      {isSelected && (
        <div className="absolute right-2 top-2 rounded-full bg-primary p-1">
          <Check className="h-3 w-3 text-primary-foreground" />
        </div>
      )}
    </button>
  );
};

type TalentAvatarProps = {
  talent: TalentWithSheets;
  onRemove?: () => void;
};

const TalentAvatar: React.FC<TalentAvatarProps> = ({ talent, onRemove }) => {
  const sheet = talent.sheets.find((s) => s.isDefault) ?? talent.sheets[0];
  // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- sheet is undefined when sheets array is empty
  const imageUrl = sheet?.imageUrl ?? talent.imageUrl;

  return (
    <div className="group relative">
      <div className="h-10 w-10 overflow-hidden rounded-full border-2 border-primary bg-muted">
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={talent.name}
            className="h-full w-full object-cover"
            style={{ objectPosition: '95% 75%' }}
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <User className="h-5 w-5 text-muted-foreground/30" />
          </div>
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="absolute -right-1 -top-1 hidden rounded-full bg-destructive p-0.5 text-destructive-foreground group-hover:block"
        >
          <X className="h-3 w-3" />
        </button>
      )}
    </div>
  );
};

export const TalentSuggestionSelector: React.FC<
  TalentSuggestionSelectorProps
> = ({ selectedTalentIds, onSelectionChange, disabled = false }) => {
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { data: talentList, isLoading } = useTalent();

  // Get selected talent objects
  const selectedTalent =
    talentList?.filter((t) => selectedTalentIds.includes(t.id)) ?? [];

  // Filter talent by search query
  const filteredTalent = talentList?.filter((t) => {
    if (!searchQuery) return true;
    return t.name.toLowerCase().includes(searchQuery.toLowerCase());
  });

  const toggleTalent = (talentId: string) => {
    if (selectedTalentIds.includes(talentId)) {
      onSelectionChange(selectedTalentIds.filter((id) => id !== talentId));
    } else {
      onSelectionChange([...selectedTalentIds, talentId]);
    }
  };

  const removeTalent = (talentId: string) => {
    onSelectionChange(selectedTalentIds.filter((id) => id !== talentId));
  };

  return (
    <>
      <div className="flex items-center gap-2">
        {/* Talent button */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setIsDialogOpen(true)}
          disabled={disabled}
          className="gap-2 text-muted-foreground"
        >
          <Users className="h-4 w-4" />
          <span>Talent</span>
        </Button>

        {/* Selected talent avatars */}
        {selectedTalent.length > 0 && (
          <div className="flex items-center -space-x-2">
            {selectedTalent.slice(0, 4).map((talent) => (
              <TalentAvatar
                key={talent.id}
                talent={talent}
                onRemove={() => removeTalent(talent.id)}
              />
            ))}
            {selectedTalent.length > 4 && (
              <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-dashed border-muted-foreground/50 bg-muted text-xs font-medium text-muted-foreground">
                +{selectedTalent.length - 4}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Multi-select dialog */}
      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              Select Talent for Casting
              {selectedTalentIds.length > 0 && (
                <span className="ml-2 text-sm font-normal text-muted-foreground">
                  ({selectedTalentIds.length} selected)
                </span>
              )}
            </DialogTitle>
            <DialogDescription>
              Optionally select talent to guide casting. The AI will match them
              to character roles based on physical descriptions.
            </DialogDescription>
          </DialogHeader>

          {/* Search input */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              type="text"
              placeholder="Search talent…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9"
            />
          </div>

          {/* Talent grid */}
          <ScrollArea className="h-[400px]">
            {isLoading ? (
              <div className="grid grid-cols-3 gap-4 p-1 sm:grid-cols-4">
                {Array.from({ length: 8 }).map((_, i) => (
                  <div key={i} className="flex flex-col items-center gap-2 p-3">
                    <Skeleton className="aspect-square w-full rounded-lg" />
                    <Skeleton className="h-4 w-3/4" />
                  </div>
                ))}
              </div>
            ) : !filteredTalent || filteredTalent.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center py-12 text-center">
                <User className="h-12 w-12 text-muted-foreground/30" />
                <p className="mt-4 text-sm text-muted-foreground">
                  {searchQuery
                    ? 'No talent matching your search'
                    : 'Your talent library is empty'}
                </p>
                {!searchQuery && (
                  <Link
                    to="/talent"
                    className="mt-2 text-sm text-primary hover:underline"
                  >
                    Go to Talent Library to add talent
                  </Link>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-4 p-1 sm:grid-cols-4">
                {filteredTalent.map((talent) => (
                  <TalentPickerCard
                    key={talent.id}
                    talent={talent}
                    isSelected={selectedTalentIds.includes(talent.id)}
                    onClick={() => toggleTalent(talent.id)}
                  />
                ))}
              </div>
            )}
          </ScrollArea>

          {/* Done button */}
          <div className="flex justify-end">
            <Button onClick={() => setIsDialogOpen(false)}>Done</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
};
