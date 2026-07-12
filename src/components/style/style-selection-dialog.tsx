import { GalleryIcon } from '@/components/icons/gallery-icon';
import { StyleGrid } from '@/components/style/style-grid';
import { StyleInlineTile } from '@/components/style/style-inline-tile';
import { StyleSelectorButton } from '@/components/style/style-selector-button';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from '@/components/ui/input-group';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  groupStylesByCategory,
  styleCategoryLabel,
} from '@/lib/style/style-assets';
import type { StyleRecommendation } from '@/hooks/use-styles';
import { catalogueWithoutRecommendations } from '@/lib/style/prioritize-recommended-styles';
import { filterStyles } from '@/lib/utils/style-filters';
import type { Style } from '@/types/database';
import { Search, X } from 'lucide-react';
import type { ChangeEvent, FC, ReactNode } from 'react';
import { useCallback, useMemo, useState } from 'react';

type StyleSelectionDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  styles?: Style[];
  selectedStyleId: string | null;
  onStyleSelect: (styleId: string) => void;
  recommendations?: StyleRecommendation[];
  recommendationsLoading?: boolean;
};

type StyleSelectionDialogContentProps = {
  styles?: Style[];
  selectedStyleId: string | null;
  onStyleSelect: (styleId: string) => void;
  onClose: () => void;
  recommendations?: StyleRecommendation[];
  recommendationsLoading?: boolean;
};

/**
 * Internal content component for the style selection dialog
 */
const StyleSelectionDialogContent: FC<StyleSelectionDialogContentProps> = ({
  styles,
  selectedStyleId,
  onStyleSelect,
  onClose,
  recommendations,
  recommendationsLoading = false,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('all');

  const isLoading = styles === undefined;
  // Category chips alphabetically (Specialized last), mirroring the styles page.
  const categories = useMemo(
    () =>
      isLoading
        ? undefined
        : ['all', ...groupStylesByCategory(styles).map((g) => g.category)],
    [styles, isLoading]
  );

  const filteredStyles = useMemo(() => {
    const filtered = [
      ...filterStyles(styles ?? [], selectedCategory, searchQuery),
    ].sort((a, b) => a.name.localeCompare(b.name));
    return catalogueWithoutRecommendations(
      filtered,
      recommendations,
      selectedStyleId
    );
  }, [styles, selectedCategory, searchQuery, recommendations, selectedStyleId]);

  const showRecommendationZone =
    recommendationsLoading || (recommendations?.length ?? 0) > 0;

  const handleOk = useCallback(() => {
    onClose();
  }, [onClose]);

  const handleStyleSelect = useCallback(
    (styleId: string) => {
      onStyleSelect(styleId);
      onClose();
    },
    [onStyleSelect, onClose]
  );

  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
  }, []);

  const handleSearchChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
  }, []);

  return (
    <DialogContent className="flex h-[90vh] max-w-[95vw] flex-col sm:max-w-[95vw] lg:max-w-[90vw] xl:max-w-[85vw]">
      <div className="flex min-h-0 flex-1 flex-col">
        <DialogHeader>
          <DialogTitle>Visual Style</DialogTitle>
          <DialogDescription>
            Choose the visual style of your sequence
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-4">
          {/* Search */}
          <InputGroup>
            <InputGroupAddon>
              <Search />
            </InputGroupAddon>
            <InputGroupInput
              placeholder="Search"
              value={searchQuery}
              onChange={handleSearchChange}
            />
            {searchQuery && (
              <InputGroupAddon align="inline-end">
                <Button variant="ghost" size="icon" onClick={handleClearSearch}>
                  <X />
                  <span className="sr-only">Clear search</span>
                </Button>
              </InputGroupAddon>
            )}
          </InputGroup>

          {/* Category Filters (hidden on mobile — shows all styles) */}
          <ToggleGroup
            type="single"
            value={selectedCategory}
            onValueChange={(value) => value && setSelectedCategory(value)}
            className="hidden sm:flex flex-wrap justify-start"
          >
            {categories?.map((category) => (
              <ToggleGroupItem
                key={category}
                value={category}
                className="rounded-full"
              >
                {category === 'all' ? 'All' : styleCategoryLabel(category)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </div>

        {/* Styles Grid */}
        <div className="min-h-0 flex-1 overflow-y-auto ">
          {filteredStyles.length === 0 &&
          !isLoading &&
          !showRecommendationZone ? (
            <Empty data-testid="empty-state">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <GalleryIcon size="lg" />
                </EmptyMedia>
                <EmptyTitle>No styles found</EmptyTitle>
                <EmptyDescription>
                  {searchQuery || selectedCategory !== 'all'
                    ? 'Try adjusting your filters or search query'
                    : 'There are currently no styles available'}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <StyleGrid
              styles={filteredStyles}
              selectedStyleId={selectedStyleId}
              onStyleSelect={onStyleSelect}
              onStyleSelectAndClose={handleStyleSelect}
              isLoading={isLoading}
              allStyles={styles}
              recommendations={recommendations}
              recommendationsLoading={recommendationsLoading}
              renderRecommendedTile={(props) => (
                <StyleInlineTile
                  key={props.style.id}
                  style={props.style}
                  selected={props.selected}
                  reasoning={props.reasoning}
                  recommended
                  tabIndex={props.tabIndex}
                  onSelect={onStyleSelect}
                  onKeyDown={props.onKeyDown}
                />
              )}
            />
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" onClick={handleOk}>
              OK
            </Button>
          </DialogClose>
        </DialogFooter>
      </div>
    </DialogContent>
  );
};

/**
 * Controlled dialog for style selection (backward compatible)
 */
export const StyleSelectionDialog: FC<StyleSelectionDialogProps> = ({
  open,
  onOpenChange,
  styles,
  selectedStyleId,
  onStyleSelect,
  recommendations,
  recommendationsLoading,
}) => {
  const handleClose = useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <StyleSelectionDialogContent
        styles={styles}
        selectedStyleId={selectedStyleId}
        onStyleSelect={onStyleSelect}
        onClose={handleClose}
        recommendations={recommendations}
        recommendationsLoading={recommendationsLoading}
      />
    </Dialog>
  );
};

/**
 * Composed dialog with trigger button
 */
type StyleSelectionDialogWithTriggerProps = {
  styles?: Style[];
  selectedStyle?: Style | null;
  onStyleSelect: (styleId: string) => void;
  trigger?: ReactNode;
  buttonSize?: 'default' | 'sm' | 'lg';
};

export const StyleSelectionDialogWithTrigger: FC<
  StyleSelectionDialogWithTriggerProps
> = ({ styles, selectedStyle, onStyleSelect, trigger, buttonSize }) => {
  const [open, setOpen] = useState(false);

  const handleClose = useCallback(() => {
    setOpen(false);
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <StyleSelectorButton
            selectedStyle={selectedStyle}
            size={buttonSize}
          />
        )}
      </DialogTrigger>
      <StyleSelectionDialogContent
        styles={styles}
        selectedStyleId={selectedStyle?.id ?? null}
        onStyleSelect={onStyleSelect}
        onClose={handleClose}
      />
    </Dialog>
  );
};
