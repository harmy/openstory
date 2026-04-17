import { useState } from 'react';
import { createFileRoute, Outlet } from '@tanstack/react-router';
import { Menu } from 'lucide-react';
import { DocsSidebar } from '@/components/docs/docs-sidebar';
import { SiteFooter } from '@/components/marketing/site-footer';
import { SiteHeader } from '@/components/marketing/site-header';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

export const Route = createFileRoute('/docs')({
  component: DocsLayout,
});

function DocsLayout() {
  const [sheetOpen, setSheetOpen] = useState(false);

  return (
    <>
      <SiteHeader />
      <div className="flex min-h-screen pt-16">
        {/* Desktop sidebar */}
        <aside className="hidden w-64 shrink-0 border-r md:block">
          <div className="sticky top-16 h-[calc(100vh-4rem)]">
            <DocsSidebar />
          </div>
        </aside>

        {/* Mobile sidebar toggle */}
        <div className="fixed bottom-4 right-4 z-40 md:hidden">
          <Button
            size="icon"
            onClick={() => setSheetOpen(true)}
            aria-label="Open documentation navigation"
          >
            <Menu className="h-5 w-5" />
          </Button>
        </div>

        <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
          <SheetContent side="left">
            <SheetHeader>
              <SheetTitle>Documentation</SheetTitle>
            </SheetHeader>
            <DocsSidebar onNavigate={() => setSheetOpen(false)} />
          </SheetContent>
        </Sheet>

        {/* Content area */}
        <main className="flex-1">
          <div className="mx-auto max-w-3xl px-6 py-10">
            <Outlet />
          </div>
        </main>
      </div>
      <SiteFooter />
    </>
  );
}
