import { RouteErrorFallback } from '@/components/error/route-error-fallback';
import { cn } from '@/lib/utils';
import { isSystemAdminFn } from '@/functions/gift-tokens';
import {
  createFileRoute,
  Link,
  Outlet,
  redirect,
  useMatchRoute,
} from '@tanstack/react-router';
import { BarChart3, FlaskConical } from 'lucide-react';

export const Route = createFileRoute('/_protected/admin')({
  beforeLoad: async () => {
    const { isAdmin } = await isSystemAdminFn();
    if (!isAdmin) {
      throw redirect({ to: '/sequences' });
    }
  },
  component: AdminLayout,
  errorComponent: (props) => (
    <RouteErrorFallback {...props} heading="Admin error" />
  ),
});

const NAV_LINKS = [
  { to: '/admin/usage' as const, label: 'Usage', icon: BarChart3 },
  { to: '/admin/eval' as const, label: 'Eval', icon: FlaskConical },
];

function AdminNav() {
  const matchRoute = useMatchRoute();

  return (
    <nav className="flex items-center gap-2 pb-3">
      {NAV_LINKS.map(({ to, label, icon: Icon }) => {
        const isActive = matchRoute({ to, fuzzy: true });
        return (
          <Link
            key={to}
            to={to}
            className={cn(
              'flex items-center gap-2 rounded-lg border px-4 py-2 text-sm font-medium transition-colors',
              isActive
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-transparent text-muted-foreground hover:border-muted hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function AdminLayout() {
  return (
    <div className="flex h-full flex-col p-6">
      <AdminNav />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Outlet />
      </div>
    </div>
  );
}
