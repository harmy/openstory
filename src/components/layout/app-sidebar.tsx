import { GitHubIcon } from '@/components/icons/github-icon';
import { XIcon } from '@/components/icons/x-icon';
import {
  OpenStoryIcon,
  OpenStoryLogo,
} from '@/components/icons/openstory-logo';
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
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar';
import { useLowBalanceWarning } from '@/hooks/use-low-balance-warning';
import { SITE_CONFIG } from '@/lib/marketing/constants';
import { Link, useRouterState } from '@tanstack/react-router';
import { useEffect } from 'react';
import {
  Clapperboard,
  LifeBuoy,
  MapPin,
  Palette,
  Plus,
  Users,
  Video,
} from 'lucide-react';
import { CreditBalancePill } from './credit-balance-pill';
import { UserSidebarFooter } from './user-sidebar-footer';

const navLinks = [
  { to: '/sequences', label: 'Sequences', icon: Video },
  { to: '/styles', label: 'Styles', icon: Palette },
  { to: '/talent', label: 'Talent', icon: Users },
  { to: '/locations', label: 'Locations', icon: MapPin },
  { to: '/gallery', label: 'Gallery', icon: Clapperboard },
] as const;

export function AppSidebar() {
  useLowBalanceWarning();

  const { isMobile, setOpenMobile } = useSidebar();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    if (isMobile) setOpenMobile(false);
  }, [pathname, isMobile, setOpenMobile]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <Link
          to="/sequences"
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
                  <Link to="/sequences/new">
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
            <SidebarMenuButton asChild tooltip="Help">
              <Link to="/docs">
                <LifeBuoy />
                <span>Help</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="GitHub">
              <a href={SITE_CONFIG.githubHref} target="_blank" rel="noreferrer">
                <GitHubIcon className="size-4" />
                <span>GitHub</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Follow OpenStory on X">
              <a href={SITE_CONFIG.xHref} target="_blank" rel="noreferrer">
                <XIcon className="size-4" />
                <span>Follow OpenStory on X</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton asChild tooltip="Follow the founder on X">
              <a
                href={SITE_CONFIG.founderXHref}
                target="_blank"
                rel="noreferrer"
              >
                <XIcon className="size-4" />
                <span>Follow the founder on X</span>
              </a>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
        <SidebarSeparator />
        <SidebarMenu>
          <UserSidebarFooter />
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
