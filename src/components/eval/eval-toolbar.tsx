import type React from 'react';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Select } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { SCRIPT_ANALYSIS_MODELS } from '@/lib/ai/models.config';
import { IMAGE_MODELS } from '@/lib/ai/models';
import {
  Clapperboard,
  ImageIcon,
  TextIcon,
  FileTextIcon,
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
}) => {
  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    onFiltersChange({ ...filters, search: e.target.value });
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

  const clearFilters = () => {
    onFiltersChange({
      search: '',
      dateFrom: null,
      dateTo: null,
      analysisModel: null,
      imageModel: null,
      workflow: null,
    });
  };

  const hasActiveFilters =
    filters.search ||
    filters.analysisModel ||
    filters.imageModel ||
    filters.workflow ||
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

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-4">
        {/* Search */}
        <Input
          placeholder={
            supportMode
              ? 'Search by title or name\u2026'
              : 'Search by title\u2026'
          }
          value={filters.search}
          onChange={handleSearchChange}
          className="w-48"
        />

        {/* Analysis Model Filter */}
        <Select
          options={analysisModelOptions}
          value={filters.analysisModel || 'all'}
          onChange={handleAnalysisModelChange}
          placeholder="Analysis Model"
          className="w-44"
        />

        {/* Image Model Filter */}
        <Select
          options={imageModelOptions}
          value={filters.imageModel || 'all'}
          onChange={handleImageModelChange}
          placeholder="Image Model"
          className="w-44"
        />

        {/* Workflow Filter */}
        {availableWorkflows.length > 0 && (
          <Select
            options={workflowOptions}
            value={filters.workflow || 'all'}
            onChange={handleWorkflowChange}
            placeholder="Workflow"
            className="w-52"
          />
        )}

        {/* Clear Filters */}
        {hasActiveFilters && (
          <Button variant="ghost" size="sm" onClick={clearFilters}>
            <X className="h-4 w-4 mr-1" />
            Clear
          </Button>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Sort Controls */}
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
                  options={sortFieldOptions}
                  value={criteria.field}
                  onChange={(value) => {
                    if (isValidSortField(value)) {
                      updateSortField(index, value);
                    }
                  }}
                  className="h-auto p-0 border-0 bg-transparent w-auto min-w-16"
                  size="sm"
                />
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

        {/* View Toggle */}
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
      </div>
    </Card>
  );
};
