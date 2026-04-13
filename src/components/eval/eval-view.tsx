import type React from 'react';
import { useState } from 'react';
import { EvalToolbar } from './eval-toolbar';
import { EvalMatrix } from './eval-matrix';
import { AdminUserSearch } from './admin-user-search';
import {
  useSequencesWithFrames,
  type SequenceWithFrames,
} from '@/hooks/use-sequences-with-frames';
import { useAdminSequencesWithFrames } from '@/hooks/use-admin-support';
import { isSystemAdminFn } from '@/functions/gift-tokens';
import { useQuery } from '@tanstack/react-query';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import { ShieldCheck, X, VideoIcon } from 'lucide-react';

export type ViewMode = 'script' | 'prompts' | 'images';

export function isValidViewMode(value: string): value is ViewMode {
  return value === 'script' || value === 'prompts' || value === 'images';
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

type SelectedTeam = {
  teamId: string;
  teamName: string;
  userName: string;
  userEmail: string;
};

export const EvalView: React.FC = () => {
  const [viewMode, setViewMode] = useState<ViewMode>('prompts');
  const [filters, setFilters] = useState<FilterState>(defaultFilters);
  const [sortCriteria, setSortCriteria] = useState<SortCriteria[]>([
    { field: 'createdAt', direction: 'desc' },
  ]);
  const [supportMode, setSupportMode] = useState(false);
  const [selectedTeam, setSelectedTeam] = useState<SelectedTeam | null>(null);

  const { data: adminStatus } = useQuery({
    queryKey: ['system-admin-status'],
    queryFn: () => isSystemAdminFn(),
    staleTime: 5 * 60 * 1000,
  });

  const isAdmin = adminStatus?.isAdmin ?? false;

  const ownData = useSequencesWithFrames();
  const adminData = useAdminSequencesWithFrames(
    supportMode && selectedTeam ? selectedTeam.teamId : null
  );

  const activeData = supportMode && selectedTeam ? adminData : ownData;
  const { data: sequences, isLoading, error } = activeData;

  // Apply filters and sorting
  const filteredAndSorted = applyFiltersAndSort(
    sequences || [],
    filters,
    sortCriteria
  );

  const supportModeToggle = isAdmin ? (
    <Card className="p-3">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-muted-foreground" />
          <Label htmlFor="support-mode" className="text-sm font-medium">
            Support Mode
          </Label>
          <Switch
            id="support-mode"
            checked={supportMode}
            onCheckedChange={(checked) => {
              setSupportMode(checked);
              if (!checked) setSelectedTeam(null);
            }}
          />
        </div>
        {supportMode && selectedTeam && (
          <div className="flex items-center gap-2 rounded-md bg-accent px-3 py-1.5">
            <span className="text-sm">
              Viewing{' '}
              <span className="font-medium">{selectedTeam.userName}</span>
              <span className="text-muted-foreground">
                {' '}
                ({selectedTeam.teamName})
              </span>
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-5 w-5"
              onClick={() => setSelectedTeam(null)}
              aria-label="Clear selected user"
            >
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>
    </Card>
  ) : null;

  // In support mode without a selected team, show user search
  if (supportMode && !selectedTeam) {
    return (
      <div className="flex-1 overflow-hidden flex flex-col gap-4">
        {supportModeToggle}
        <AdminUserSearch onSelect={setSelectedTeam} />
      </div>
    );
  }

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

  if (!sequences || sequences.length === 0) {
    return (
      <div className="flex-1 overflow-hidden flex flex-col gap-4">
        {supportModeToggle}
        <EmptyState
          icon={<VideoIcon className="h-12 w-12" />}
          title="No sequences yet"
          description={
            supportMode
              ? 'This user has no sequences.'
              : 'Create some sequences to start evaluating prompts.'
          }
        />
      </div>
    );
  }

  // Get unique workflows for filter dropdown
  const availableWorkflows = [
    ...new Set(
      sequences.map((s) => s.workflow).filter((w): w is string => w !== null)
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
      />
      {filteredAndSorted.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="text-muted-foreground">
            No sequences match your filters.
          </p>
        </Card>
      ) : (
        <EvalMatrix sequences={filteredAndSorted} viewMode={viewMode} />
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
    result = result.filter((s) => s.title.toLowerCase().includes(searchLower));
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
