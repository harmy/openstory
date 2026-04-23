/**
 * User Badge Component
 * Displays user authentication state with login/logout actions
 */

import {
  BarChart3,
  FlaskConical,
  LogOut,
  Settings,
  User,
  Wallet,
} from 'lucide-react';
import { Route as sequencesRoute } from '@/routes/_protected/sequences/index';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { isSystemAdminFn } from '@/functions/gift-tokens';
import { useUser } from '@/hooks/use-user';
import { authClient } from '@/lib/auth/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';

export function UserBadge() {
  const { data: user, isLoading } = useUser();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Show loading state or no user data
  if (isLoading || !user) {
    return (
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 rounded-full bg-muted animate-pulse" />
      </div>
    );
  }

  // Authenticated user - show user menu
  const userEmail = user.email;
  const displayName = user.name || userEmail || 'User';
  const initials = getInitials(displayName);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    queryClient.removeQueries({ queryKey: ['session'] });
    // Sign out - this should clear the session cookie
    // Note: Better Auth has a known issue (github.com/better-auth/better-auth/issues/3608)
    // where useSession doesn't update after server-side signOut until page refresh
    await authClient.signOut({
      fetchOptions: {
        onSuccess: () => {
          void navigate({ to: '/' });
        },
      },
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" className="relative h-10 w-10 rounded-full">
          <Avatar className="h-10 w-10">
            <AvatarImage src={user.image || undefined} alt={displayName} />
            <AvatarFallback>{initials}</AvatarFallback>
          </Avatar>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent className="w-56" align="end">
        <DropdownMenuLabel>
          <div className="flex flex-col space-y-1">
            <p className="text-sm font-medium leading-none">{displayName}</p>
            {userEmail && (
              <p className="text-xs leading-none text-muted-foreground">
                {userEmail}
              </p>
            )}
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to={sequencesRoute.to}>
            <User className="mr-2 h-4 w-4" />
            My Sequences
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <Settings className="mr-2 h-4 w-4" />
            Settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/credits">
            <Wallet className="mr-2 h-4 w-4" />
            Credits
          </Link>
        </DropdownMenuItem>
        <AdminMenuItem />
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => void handleSignOut()}
          disabled={isSigningOut}
        >
          <LogOut className="mr-2 h-4 w-4" />
          {isSigningOut ? 'Signing out...' : 'Sign Out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AdminMenuItem() {
  const { data: adminStatus } = useQuery({
    queryKey: ['system-admin-status'],
    queryFn: () => isSystemAdminFn(),
    staleTime: 5 * 60 * 1000,
  });

  if (!adminStatus?.isAdmin) return null;

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
        Admin
      </DropdownMenuLabel>
      <DropdownMenuItem asChild>
        <Link to="/admin/usage">
          <BarChart3 className="mr-2 h-4 w-4" />
          Usage
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link to="/admin/eval">
          <FlaskConical className="mr-2 h-4 w-4" />
          Eval
        </Link>
      </DropdownMenuItem>
    </>
  );
}

/**
 * Get user initials from display name
 */
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);

  if (parts.length === 1) {
    // Single name - use first 2 characters
    return parts[0].substring(0, 2).toUpperCase();
  }

  // Multiple names - use first letter of first and last name
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
