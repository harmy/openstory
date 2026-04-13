import type React from 'react';
import { useMemo, useState } from 'react';
import { EvalToolbar } from './eval-toolbar';
import { EvalMatrix } from './eval-matrix';
import {
  useSequencesWithFrames,
  type SequenceWithFrames,
} from '@/hooks/use-sequences-with-frames';
import { useAdminAllSequencesWithFrames } from '@/hooks/use-admin-support';
import { isSystemAdminFn } from '@/functions/gift-tokens';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ShieldCheck, VideoIcon } from 'lucide-react';

export type ViewMode = 'script' | 'prompts' | 'images' | 'motion';

export function isValidViewMode(value: string): value is ViewMode {
  return (
    value === 'script' ||
    value === 'prompts' ||
    value === 'images' ||
    value === 'motion'
  );
}

export function isValidSortField(
  value: string
): value is SortCriteria['field'] {
  return (
    value === 'title' ||
    value === 'createdAt' ||
    value === 'analysisModel' ||
    value === 'imageModel' ||
    value === 'workflow'
  );
}

export type FilterState = {
  search: string;
  dateFrom: Date | null;
  dateTo: Date | null;
  analysisModel: string | null;
  imageModel: string | null;
  workflow: string | null;
};

export type SortCriteria = {
  field: 'title' | 'createdAt' | 'analysisModel' | 'imageModel' | 'workflow';
  direction: 'asc' | 'desc';
};

const defaultFilters: FilterState = {
  search: '',
  dateFrom: null,
  dateTo: null,
  analysisModel: null,
  imageModel: null,
  workflow: null,
};

export const EvalView: React.FC = () => {
  const [viewMode, setViewMode] = useState<ViewMode>('prompts');
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [sortCriteria, setSortCriteria] = useState<SortCriteria[]>([
    { field: 'createdAt', direction: 'desc' },
  ]);
  const [supportMode, setSupportMode] = useState(false);

  const { data: adminStatus } = useQuery({
    queryKey: ['system-admin-status'],
    queryFn: () => isSystemAdminFn(),
    staleTime: 5 * 60 * 1000,
  });

  const isAdmin = adminStatus?.isAdmin ?? false;

  const ownData = useSequencesWithFrames();
  const adminData = useAdminAllSequencesWithFrames(supportMode);

  const sequences: SequenceWithFrames[] | undefined = supportMode
    ? adminData.data
    : ownData.data;
  const isLoading = supportMode ? adminData.isLoading : ownData.isLoading;
  const error = supportMode ? adminData.error : ownData.error;

  // Client-side filtering for both modes
  const filteredAndSorted = useMemo(
    () => applyFiltersAndSort(sequences || [], filters, sortCriteria),
    [sequences, filters, sortCriteria]
  );

  const handleLoadMore = supportMode
    ? () => {
        if (adminData.hasNextPage && !adminData.isFetchingNextPage) {
          void adminData.fetchNextPage();
        }
      }
    : undefined;

  const supportModeToggle = isAdmin ? (
    <Card className="p-3">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-muted-foreground" />
        <Label htmlFor="support-mode" className="text-sm font-medium">
          Support Mode
        </Label>
        <Switch
          id="support-mode"
          checked={supportMode}
          onCheckedChange={setSupportMode}
        />
      </div>
    </Card>
  ) : null;

  if (isLoading) {
    return (
      <div className="flex-1 overflow-hidden flex flex-col gap-4">
        {supportModeToggle}
        <Card className="p-4">
          <div className="flex items-center gap-4">
            <Skeleton className="h-9 w-48" />
            <Skeleton className="h-9 w-32" />
            <Skeleton className="h-9 w-32" />
            <div className="flex-1" />
            <Skeleton className="h-9 w-40" />
          </div>
        </Card>
        <Card className="flex-1 p-4">
          <div className="space-y-4">
            {[1, 2, 3].map((n) => (
              <div key={`skeleton-${n}`} className="flex gap-4">
                <Skeleton className="h-24 w-64" />
                <Skeleton className="h-24 w-48" />
                <Skeleton className="h-24 w-48" />
                <Skeleton className="h-24 w-48" />
              </div>
            ))}
          </div>
        </Card>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex-1 overflow-hidden flex flex-col gap-4">
        {supportModeToggle}
        <Card className="p-8 text-center">
          <p className="text-destructive">
            Failed to load sequences: {error.message}
          </p>
        </Card>
      </div>
    );
  }

  // Get unique workflows for filter dropdown
  const availableWorkflows = [
    ...new Set(
      (sequences ?? [])
        .map((s) => s.workflow)
        .filter((w): w is string => w !== null)
    ),
  ].sort();

  return (
    <div className="flex-1 overflow-hidden flex flex-col gap-4">
      {supportModeToggle}
      <EvalToolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        filters={filters}
        onFiltersChange={setFilters}
        sortCriteria={sortCriteria}
        onSortChange={setSortCriteria}
        availableWorkflows={availableWorkflows}
        supportMode={supportMode}
      />
      {filteredAndSorted.length === 0 ? (
        <EmptyState
          icon={<VideoIcon className="h-12 w-12" />}
          title={filters.search ? 'No matching sequences' : 'No sequences yet'}
          description={
            filters.search
              ? `No sequences match "${filters.search}".`
              : supportMode
                ? 'No sequences found across any users.'
                : 'Create some sequences to start evaluating prompts.'
          }
        />
      ) : (
        <EvalMatrix
          sequences={filteredAndSorted}
          viewMode={viewMode}
          onLoadMore={handleLoadMore}
          hasMore={supportMode ? adminData.hasNextPage : false}
        />
      )}
    </div>
  );
};

function applyFiltersAndSort(
  sequences: SequenceWithFrames[],
  filters: FilterState,
  sortCriteria: SortCriteria[]
): SequenceWithFrames[] {
  let result = [...sequences];

  // Apply filters
  if (filters.search) {
    const searchLower = filters.search.toLowerCase();
    result = result.filter((s) => {
      if (s.title.toLowerCase().includes(searchLower)) return true;
      if (
        'creatorName' in s &&
        typeof s.creatorName === 'string' &&
        s.creatorName.toLowerCase().includes(searchLower)
      )
        return true;
      return false;
    });
  }

  const { dateFrom, dateTo } = filters;
  if (dateFrom) {
    result = result.filter((s) => new Date(s.createdAt) >= dateFrom);
  }

  if (dateTo) {
    result = result.filter((s) => new Date(s.createdAt) <= dateTo);
  }

  if (filters.analysisModel) {
    result = result.filter((s) => s.analysisModel === filters.analysisModel);
  }

  if (filters.imageModel) {
    result = result.filter((s) => s.imageModel === filters.imageModel);
  }

  if (filters.workflow) {
    result = result.filter((s) => s.workflow === filters.workflow);
  }

  // Apply multi-criteria sort
  result.sort((a, b) => {
    for (const criteria of sortCriteria) {
      const aVal = a[criteria.field];
      const bVal = b[criteria.field];

      let cmp: number;
      if (criteria.field === 'createdAt') {
        const aTime = aVal ? new Date(aVal).getTime() : 0;
        const bTime = bVal ? new Date(bVal).getTime() : 0;
        cmp = aTime - bTime;
      } else {
        cmp = String(aVal ?? '').localeCompare(String(bVal ?? ''));
      }

      if (cmp !== 0) {
        return criteria.direction === 'asc' ? cmp : -cmp;
      }
    }
    return 0;
  });

  return result;
}
