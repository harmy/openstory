import { RouteErrorFallback } from '@/components/error/route-error-fallback';
import { PageContainer } from '@/components/layout/page-container';
import { isSystemAdminFn } from '@/functions/gift-tokens';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_protected/admin')({
  beforeLoad: async () => {
    const { isAdmin } = await isSystemAdminFn();
    if (!isAdmin) {
      throw redirect({ to: '/sequences' });
    }
  },
  component: AdminLayout,
  staticData: { breadcrumb: { label: 'Admin', to: '/admin/usage' } },
  errorComponent: (props) => (
    <RouteErrorFallback {...props} heading="Admin error" />
  ),
});

function AdminLayout() {
  return (
    <PageContainer
      maxWidth="full"
      padding="compact"
      className="flex-1 flex flex-col overflow-hidden"
    >
      <Outlet />
    </PageContainer>
  );
}
