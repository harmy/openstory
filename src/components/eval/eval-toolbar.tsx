import type React from 'react';
import { useEffect, useState } from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { SCRIPT_ANALYSIS_MODELS } from '@/lib/ai/models.config';
import { IMAGE_MODELS } from '@/lib/ai/models';
import { ASPECT_RATIOS } from '@/lib/constants/aspect-ratios';
import {
  Clapperboard,
  ImageIcon,
  TextIcon,
  FileTextIcon,
  ShieldCheck,
  X,
  ArrowUpDown,
  Plus,
} from 'lucide-react';
import {
  isValidSortField,
  isValidViewMode,
  type FilterState,
  type SortCriteria,
  type ViewMode,
} from './eval-view';

type EvalToolbarProps = {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  filters: FilterState;
  onFiltersChange: (filters: FilterState) => void;
  sortCriteria: SortCriteria[];
  onSortChange: (criteria: SortCriteria[]) => void;
  availableWorkflows: string[];
  supportMode?: boolean;
  // Support-mode controls (rendered inline when isAdmin is true)
  isAdmin?: boolean;
  onSupportModeChange?: (value: boolean) => void;
  hideInternal?: boolean;
  onHideInternalChange?: (value: boolean) => void;
  hideInternalAvailable?: boolean;
  hideInternalLocked?: boolean;
};

const SORT_FIELDS: { value: SortCriteria['field']; label: string }[] = [
  { value: 'createdAt', label: 'Date' },
  { value: 'title', label: 'Title' },
  { value: 'analysisModel', label: 'Analysis Model' },
  { value: 'imageModel', label: 'Image Model' },
  { value: 'workflow', label: 'Workflow' },
];

export const EvalToolbar: React.FC<EvalToolbarProps> = ({
  viewMode,
  onViewModeChange,
  filters,
  onFiltersChange,
  sortCriteria,
  onSortChange,
  availableWorkflows,
  supportMode,
  isAdmin,
  onSupportModeChange,
  hideInternal,
  onHideInternalChange,
  hideInternalAvailable,
  hideInternalLocked,
}) => {
  const [searchDraft, setSearchDraft] = useState(filters.search);

  // Reset draft when the committed search changes from outside (e.g. Clear).
  useEffect(() => {
    setSearchDraft(filters.search);
  }, [filters.search]);

  // Debounce draft → committed search to avoid a server roundtrip per keystroke.
  useEffect(() => {
    if (searchDraft === filters.search) return;
    const t = setTimeout(() => {
      onFiltersChange({ ...filters, search: searchDraft });
    }, 250);
    return () => clearTimeout(t);
  }, [searchDraft, filters, onFiltersChange]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchDraft(e.target.value);
  };

  const handleAnalysisModelChange = (value: string) => {
    onFiltersChange({
      ...filters,
      analysisModel: value === 'all' ? null : value,
    });
  };

  const handleImageModelChange = (value: string) => {
    onFiltersChange({
      ...filters,
      imageModel: value === 'all' ? null : value,
    });
  };

  const handleWorkflowChange = (value: string) => {
    onFiltersChange({
      ...filters,
      workflow: value === 'all' ? null : value,
    });
  };

  const handleAspectRatioChange = (value: string) => {
    const match = ASPECT_RATIOS.find((r) => r.value === value);
    onFiltersChange({
      ...filters,
      aspectRatio: match ? match.value : null,
    });
  };

  const clearFilters = () => {
    onFiltersChange({
      search: '',
      dateFrom: null,
      dateTo: null,
      analysisModel: null,
      imageModel: null,
      workflow: null,
      aspectRatio: null,
      hasMergedVideo: false,
    });
  };

  const hasActiveFilters =
    filters.search ||
    filters.analysisModel ||
    filters.imageModel ||
    filters.workflow ||
    filters.aspectRatio ||
    filters.hasMergedVideo ||
    filters.dateFrom ||
    filters.dateTo;

  const addSortCriteria = () => {
    if (sortCriteria.length >= 3) return;
    const usedFields = new Set(sortCriteria.map((c) => c.field));
    const availableField = SORT_FIELDS.find((f) => !usedFields.has(f.value));
    if (availableField) {
      onSortChange([
        ...sortCriteria,
        { field: availableField.value, direction: 'desc' },
      ]);
    }
  };

  const removeSortCriteria = (index: number) => {
    if (sortCriteria.length <= 1) return;
    onSortChange(sortCriteria.filter((_, i) => i !== index));
  };

  const toggleSortDirection = (index: number) => {
    const updated = [...sortCriteria];
    updated[index] = {
      ...updated[index],
      direction: updated[index].direction === 'asc' ? 'desc' : 'asc',
    };
    onSortChange(updated);
  };

  const updateSortField = (index: number, field: SortCriteria['field']) => {
    const updated = [...sortCriteria];
    updated[index] = { ...updated[index], field };
    onSortChange(updated);
  };

  // Build options for select components
  const analysisModelOptions = [
    { value: 'all', label: 'All Analysis Models' },
    ...SCRIPT_ANALYSIS_MODELS.map((model) => ({
      value: model.id,
      label: model.name,
    })),
  ];

  const imageModelOptions = [
    { value: 'all', label: 'All Image Models' },
    ...Object.values(IMAGE_MODELS)
      .filter((m) => !('hidden' in m))
      .map((model) => ({
        value: model.id,
        label: model.name,
      })),
  ];

  const workflowOptions = [
    { value: 'all', label: 'All Workflows' },
    ...availableWorkflows.map((workflow) => ({
      value: workflow,
      label: workflow,
    })),
  ];

  const aspectRatioOptions = [
    { value: 'all', label: 'All Aspect Ratios' },
    ...ASPECT_RATIOS.map((r) => ({ value: r.value, label: r.label })),
  ];

  return (
    <Card className="p-3">
      <div className="flex flex-col gap-3">
        {/* Row 1: filters */}
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder={
              supportMode
                ? 'Search by title, name, or email…'
                : 'Search by title…'
            }
            value={searchDraft}
            onChange={handleSearchChange}
            className="w-48"
          />
          <Select
            value={filters.analysisModel || 'all'}
            onValueChange={handleAnalysisModelChange}
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Analysis Model" />
            </SelectTrigger>
            <SelectContent>
              {analysisModelOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={filters.imageModel || 'all'}
            onValueChange={handleImageModelChange}
          >
            <SelectTrigger className="w-44">
              <SelectValue placeholder="Image Model" />
            </SelectTrigger>
            <SelectContent>
              {imageModelOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {availableWorkflows.length > 0 && (
            <Select
              value={filters.workflow || 'all'}
              onValueChange={handleWorkflowChange}
            >
              <SelectTrigger className="w-52">
                <SelectValue placeholder="Workflow" />
              </SelectTrigger>
              <SelectContent>
                {workflowOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Select
            value={filters.aspectRatio || 'all'}
            onValueChange={handleAspectRatioChange}
          >
            <SelectTrigger className="w-36">
              <SelectValue placeholder="Aspect Ratio" />
            </SelectTrigger>
            <SelectContent>
              {aspectRatioOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <label
            htmlFor="filter-has-merged-video"
            className="flex items-center gap-2 text-sm cursor-pointer select-none"
          >
            <Checkbox
              id="filter-has-merged-video"
              checked={filters.hasMergedVideo}
              onCheckedChange={(checked) =>
                onFiltersChange({
                  ...filters,
                  hasMergedVideo: checked === true,
                })
              }
            />
            Has video
          </label>
          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="h-4 w-4 mr-1" />
              Clear
            </Button>
          )}
        </div>

        {/* Row 2: view toggle, sort, support mode */}
        <div className="flex flex-wrap items-center gap-3">
          <ToggleGroup
            type="single"
            value={viewMode}
            onValueChange={(value) => {
              if (value && isValidViewMode(value)) {
                onViewModeChange(value);
              }
            }}
            variant="outline"
          >
            <ToggleGroupItem value="script" aria-label="Show script">
              <FileTextIcon className="h-4 w-4 mr-2" />
              Script
            </ToggleGroupItem>
            <ToggleGroupItem value="prompts" aria-label="Show prompts">
              <TextIcon className="h-4 w-4 mr-2" />
              Prompts
            </ToggleGroupItem>
            <ToggleGroupItem value="images" aria-label="Show images">
              <ImageIcon className="h-4 w-4 mr-2" />
              Images
            </ToggleGroupItem>
            <ToggleGroupItem value="motion" aria-label="Show frame videos">
              <Clapperboard className="h-4 w-4 mr-2" />
              Motion
            </ToggleGroupItem>
          </ToggleGroup>

          <div className="flex items-center gap-2">
            <ArrowUpDown className="h-4 w-4 text-muted-foreground" />
            {sortCriteria.map((criteria, index) => {
              const usedFields = new Set(
                sortCriteria.filter((_, i) => i !== index).map((c) => c.field)
              );
              const sortFieldOptions = SORT_FIELDS.filter(
                (f) => !usedFields.has(f.value) || f.value === criteria.field
              ).map((f) => ({ value: f.value, label: f.label }));

              return (
                <Badge
                  key={criteria.field}
                  variant="secondary"
                  className="flex items-center gap-1 px-2 py-1"
                >
                  <Select
                    value={criteria.field}
                    onValueChange={(value) => {
                      if (isValidSortField(value)) {
                        updateSortField(index, value);
                      }
                    }}
                  >
                    <SelectTrigger
                      size="sm"
                      className="h-auto p-0 border-0 bg-transparent w-auto min-w-16"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {sortFieldOptions.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-4 w-4 p-0"
                    onClick={() => toggleSortDirection(index)}
                  >
                    {criteria.direction === 'asc' ? '↑' : '↓'}
                  </Button>
                  {sortCriteria.length > 1 && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-4 w-4 p-0"
                      onClick={() => removeSortCriteria(index)}
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  )}
                </Badge>
              );
            })}
            {sortCriteria.length < 3 && (
              <Button
                variant="ghost"
                size="icon"
                className="h-6 w-6"
                onClick={addSortCriteria}
              >
                <Plus className="h-4 w-4" />
              </Button>
            )}
          </div>

          {/* Support Mode (admin only) — pushed to end of row */}
          {isAdmin && (
            <div className="ml-auto flex items-center gap-4">
              {supportMode && hideInternalAvailable && (
                <div className="flex items-center gap-2">
                  <Label
                    htmlFor="hide-internal"
                    className="text-sm font-medium"
                  >
                    Hide internal
                  </Label>
                  <Switch
                    id="hide-internal"
                    checked={Boolean(hideInternal)}
                    onCheckedChange={(v) => onHideInternalChange?.(v)}
                    disabled={Boolean(hideInternalLocked)}
                  />
                </div>
              )}
              <div className="flex items-center gap-2">
                <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                <Label htmlFor="support-mode" className="text-sm font-medium">
                  Support
                </Label>
                <Switch
                  id="support-mode"
                  checked={Boolean(supportMode)}
                  onCheckedChange={(v) => onSupportModeChange?.(v)}
                />
              </div>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
};
