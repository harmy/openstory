import { Link, useRouterState } from '@tanstack/react-router';
import { allDocs } from 'content-collections';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SECTION_ORDER } from '@/lib/docs/sections';

type DocsSidebarProps = {
  onNavigate?: () => void;
};

function buildNavTree() {
  const grouped = new Map<string, typeof allDocs>();

  for (const doc of allDocs) {
    const existing = grouped.get(doc.section);
    if (existing) {
      existing.push(doc);
    } else {
      grouped.set(doc.section, [doc]);
    }
  }

  // Sort items within each group by order
  for (const items of grouped.values()) {
    items.sort((a, b) => a.order - b.order);
  }

  // Return sections in fixed order, filtering out any that have no docs
  return SECTION_ORDER.reduce<{ section: string; items: typeof allDocs }[]>(
    (acc, section) => {
      const items = grouped.get(section);
      if (items) {
        acc.push({ section, items });
      }
      return acc;
    },
    []
  );
}

const navTree = buildNavTree();

export const DocsSidebar: React.FC<DocsSidebarProps> = ({ onNavigate }) => {
  const routerState = useRouterState();
  const currentPath = routerState.location.pathname;

  return (
    <ScrollArea className="h-full">
      <nav className="flex flex-col gap-6 p-4" aria-label="Documentation">
        {navTree.map(({ section, items }) => (
          <div key={section} className="flex flex-col gap-1">
            <h3 className="px-3 text-xs font-semibold tracking-wider text-muted-foreground uppercase">
              {section}
            </h3>
            <ul className="flex flex-col gap-0.5">
              {items.map((doc) => {
                const href = `/docs/${doc.slug}`;
                const isActive =
                  currentPath === href || currentPath === `${href}/`;

                return (
                  <li key={doc.slug}>
                    <Link
                      to={href}
                      onClick={onNavigate}
                      className={`block rounded-md px-3 py-1.5 text-sm transition-colors ${
                        isActive
                          ? 'bg-accent font-medium text-accent-foreground'
                          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
                      }`}
                    >
                      {doc.title}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>
    </ScrollArea>
  );
};
