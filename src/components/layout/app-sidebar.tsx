import {
  OpenStoryIcon,
  OpenStoryLogo,
} from '@/components/icons/openstory-logo';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { isSystemAdminFn } from '@/functions/gift-tokens';
import { useLowBalanceWarning } from '@/hooks/use-low-balance-warning';
import { useUser } from '@/hooks/use-user';
import { authClient } from '@/lib/auth/client';
import { Route as locationsRoute } from '@/routes/_protected/locations/index';
import { Route as sequencesRoute } from '@/routes/_protected/sequences/index';
import { Route as sequencesNewRoute } from '@/routes/_protected/sequences/new';
import { Route as talentRoute } from '@/routes/_protected/talent/index';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import {
  BarChart3,
  BookOpen,
  ChevronsUpDown,
  FlaskConical,
  LogOut,
  MapPin,
  Plus,
  Settings,
  Users,
  Video,
  Wallet,
} from 'lucide-react';
import { useState } from 'react';
import { CreditBalancePill } from './credit-balance-pill';

const navLinks = [
  { to: sequencesRoute.to, label: 'Sequences', icon: Video },
  { to: talentRoute.to, label: 'Talent', icon: Users },
  { to: locationsRoute.to, label: 'Locations', icon: MapPin },
] as const;

export function AppSidebar() {
  useLowBalanceWarning();

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link
          to={sequencesRoute.to}
          className="flex h-10 items-center px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <OpenStoryLogo
            size="md"
            className="group-data-[collapsible=icon]:hidden"
          />
          <OpenStoryIcon
            size="md"
            className="hidden group-data-[collapsible=icon]:block"
          />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="New sequence">
                  <Link to={sequencesNewRoute.to}>
                    <Plus />
                    <span>New sequence</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
              {navLinks.map(({ to, label, icon: Icon }) => (
                <SidebarMenuItem key={label}>
                  <SidebarMenuButton asChild tooltip={label}>
                    <Link
                      to={to}
                      activeProps={{ 'data-active': 'true' }}
                      activeOptions={{ exact: false }}
                    >
                      <Icon />
                      <span>{label}</span>
                    </Link>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
              <CreditBalancePill />
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Guide">
              <Link to="/docs">
                <BookOpen />
                <span>Guide</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <UserFooter />
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function UserFooter() {
  const { data: user, isLoading } = useUser();
  const [isSigningOut, setIsSigningOut] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  if (isLoading || !user) {
    return (
      <SidebarMenuButton size="lg" disabled>
        <div className="h-8 w-8 shrink-0 rounded-full bg-muted animate-pulse" />
        <div className="flex flex-1 flex-col gap-1">
          <div className="h-3 w-24 rounded bg-muted animate-pulse" />
          <div className="h-2.5 w-32 rounded bg-muted animate-pulse" />
        </div>
      </SidebarMenuButton>
    );
  }

  const userEmail = user.email;
  const displayName = user.name || userEmail || 'User';
  const initials = getInitials(displayName);

  const handleSignOut = async () => {
    setIsSigningOut(true);
    queryClient.removeQueries({ queryKey: ['session'] });
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
        <SidebarMenuButton
          size="lg"
          className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
        >
          <Avatar className="h-8 w-8 rounded-lg">
            <AvatarImage src={user.image || undefined} alt={displayName} />
            <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
          </Avatar>
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-medium">{displayName}</span>
            {userEmail && (
              <span className="truncate text-xs text-muted-foreground">
                {userEmail}
              </span>
            )}
          </div>
          <ChevronsUpDown className="ml-auto size-4" />
        </SidebarMenuButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="end"
        sideOffset={4}
        className="w-(--radix-dropdown-menu-trigger-width) min-w-56 rounded-lg"
      >
        <DropdownMenuLabel className="p-0 font-normal">
          <div className="flex items-center gap-2 px-1 py-1.5 text-left text-sm">
            <Avatar className="h-8 w-8 rounded-lg">
              <AvatarImage src={user.image || undefined} alt={displayName} />
              <AvatarFallback className="rounded-lg">{initials}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">{displayName}</span>
              {userEmail && (
                <span className="truncate text-xs text-muted-foreground">
                  {userEmail}
                </span>
              )}
            </div>
          </div>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
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
          {isSigningOut ? 'Signing out…' : 'Sign Out'}
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
      <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
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

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) {
    return parts[0].substring(0, 2).toUpperCase();
  }
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}
