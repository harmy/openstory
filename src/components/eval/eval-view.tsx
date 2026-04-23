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
import { VideoIcon } from 'lucide-react';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';

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
  aspectRatio: AspectRatio | null;
  hasMergedVideo: boolean;
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
  aspectRatio: null,
  hasMergedVideo: false,
};

type EvalViewProps = {
  initialUserFilter?: string;
};

export const EvalView: React.FC<EvalViewProps> = ({ initialUserFilter }) => {
  const [viewMode, setViewMode] = useState<ViewMode>('prompts');
  const [filters, setFilters] = useState<FilterState>(() =>
    initialUserFilter
      ? { ...defaultFilters, search: initialUserFilter }
      : defaultFilters
  );
  const [sortCriteria, setSortCriteria] = useState<SortCriteria[]>([
    { field: 'createdAt', direction: 'desc' },
  ]);
  const [supportMode, setSupportMode] = useState(Boolean(initialUserFilter));
  const [hideInternal, setHideInternal] = useState(false);

  const { data: adminStatus } = useQuery({
    queryKey: ['system-admin-status'],
    queryFn: () => isSystemAdminFn(),
    staleTime: 5 * 60 * 1000,
  });

  const isAdmin = adminStatus?.isAdmin ?? false;
  const internalDomains = useMemo(
    () => adminStatus?.internalDomains ?? [],
    [adminStatus?.internalDomains]
  );

  const ownData = useSequencesWithFrames();
  const adminData = useAdminAllSequencesWithFrames(
    supportMode,
    supportMode ? filters.search : undefined
  );

  const sequences: SequenceWithFrames[] = supportMode
    ? adminData.data
    : ownData.data;
  const isLoading = supportMode ? adminData.isLoading : ownData.isLoading;
  const framesLoadingMap = supportMode
    ? adminData.framesLoadingMap
    : ownData.framesLoadingMap;
  const error = supportMode ? adminData.error : ownData.error;

  // Deep link wins: when a specific user is requested, never hide them.
  const effectiveHideInternal =
    hideInternal && !initialUserFilter && internalDomains.length > 0;

  // Client-side filtering for both modes. In support mode the server also
  // filters by search so this is a no-op; keeping it for own-data mode.
  const filteredAndSorted = useMemo(
    () =>
      applyFiltersAndSort(
        sequences,
        filters,
        sortCriteria,
        effectiveHideInternal ? internalDomains : []
      ),
    [sequences, filters, sortCriteria, effectiveHideInternal, internalDomains]
  );

  const handleLoadMore = supportMode
    ? () => {
        if (adminData.hasNextPage && !adminData.isFetchingNextPage) {
          void adminData.fetchNextPage();
        }
      }
    : undefined;

  if (error) {
    return (
      <div className="flex-1 overflow-hidden flex flex-col gap-4">
        <Card className="p-8 text-center">
          <p className="text-destructive">
            Failed to load sequences: {error.message}
          </p>
        </Card>
      </div>
    );
  }

  // Unique workflows for filter dropdown — computed from loaded sequences.
  const availableWorkflows = [
    ...new Set(
      sequences.map((s) => s.workflow).filter((w): w is string => w !== null)
    ),
  ].sort();

  return (
    <div className="flex-1 overflow-hidden flex flex-col gap-4">
      <EvalToolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        filters={filters}
        onFiltersChange={setFilters}
        sortCriteria={sortCriteria}
        onSortChange={setSortCriteria}
        availableWorkflows={availableWorkflows}
        supportMode={supportMode}
        isAdmin={isAdmin}
        onSupportModeChange={setSupportMode}
        hideInternal={hideInternal}
        onHideInternalChange={setHideInternal}
        hideInternalAvailable={internalDomains.length > 0}
        hideInternalLocked={Boolean(initialUserFilter)}
      />
      {isLoading ? (
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
      ) : filteredAndSorted.length === 0 ? (
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
          framesLoadingMap={framesLoadingMap}
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
  sortCriteria: SortCriteria[],
  hideDomains: string[]
): SequenceWithFrames[] {
  let result = [...sequences];

  if (hideDomains.length > 0) {
    const suffixes = hideDomains.map((d) => `@${d.toLowerCase()}`);
    result = result.filter((s) => {
      if (!('creatorEmail' in s) || typeof s.creatorEmail !== 'string') {
        return true;
      }
      const email = s.creatorEmail.toLowerCase();
      return !suffixes.some((suffix) => email.endsWith(suffix));
    });
  }

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
      if (
        'creatorEmail' in s &&
        typeof s.creatorEmail === 'string' &&
        s.creatorEmail.toLowerCase().includes(searchLower)
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

  if (filters.aspectRatio) {
    result = result.filter((s) => s.aspectRatio === filters.aspectRatio);
  }

  if (filters.hasMergedVideo) {
    result = result.filter((s) => Boolean(s.mergedVideoUrl));
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
