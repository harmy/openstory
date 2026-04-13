import { useState } from 'react';
import { useAdminUserSearch } from '@/hooks/use-admin-support';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Search, Users } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';

type SelectedTeam = {
  teamId: string;
  teamName: string;
  userName: string;
  userEmail: string;
};

type AdminUserSearchProps = {
  onSelect: (team: SelectedTeam) => void;
};

export const AdminUserSearch: React.FC<AdminUserSearchProps> = ({
  onSelect,
}) => {
  const [query, setQuery] = useState('');
  const { data: results, isLoading } = useAdminUserSearch(query);

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          placeholder="Search users by email or name…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="pl-9"
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
      </div>

      {query.length >= 2 && isLoading && (
        <div className="flex flex-col gap-2">
          {[1, 2, 3].map((n) => (
            <Skeleton key={`skeleton-${n}`} className="h-16 w-full" />
          ))}
        </div>
      )}

      {query.length >= 2 && !isLoading && results?.length === 0 && (
        <Card className="p-6">
          <p className="text-center text-muted-foreground">
            No users found matching "{query}"
          </p>
        </Card>
      )}

      {query.length < 2 && (
        <EmptyState
          icon={<Users className="h-12 w-12" />}
          title="Search for a user"
          description="Enter at least 2 characters to search by name or email."
        />
      )}

      {results && results.length > 0 && (
        <div className="flex flex-col gap-2">
          {results.map((result) => (
            <button
              key={`${result.userId}-${result.teamId}`}
              type="button"
              onClick={() =>
                onSelect({
                  teamId: result.teamId,
                  teamName: result.teamName,
                  userName: result.name,
                  userEmail: result.email,
                })
              }
              className="flex items-center gap-4 rounded-lg border p-4 text-left transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-muted text-sm font-medium">
                {result.name
                  .split(' ')
                  .map((n) => n[0])
                  .join('')
                  .slice(0, 2)
                  .toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{result.name}</p>
                <p className="truncate text-sm text-muted-foreground">
                  {result.email}
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="text-sm text-muted-foreground">
                  {result.teamName}
                </p>
                <p className="text-xs text-muted-foreground">{result.role}</p>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
