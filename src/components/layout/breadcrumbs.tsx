import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import type { AnyRouteMatch } from '@tanstack/react-router';
import { Link, useMatches } from '@tanstack/react-router';
import { Fragment } from 'react';

export type BreadcrumbCrumb = {
  label: React.ReactNode;
  to?: string;
};

export type BreadcrumbValue =
  | string
  | BreadcrumbCrumb
  | BreadcrumbCrumb[]
  | ((
      match: AnyRouteMatch
    ) => string | BreadcrumbCrumb | BreadcrumbCrumb[] | null | undefined);

// See https://tanstack.com/router/latest/docs/guide/static-route-data#enforcing-static-data
declare module '@tanstack/react-router' {
  interface StaticDataRouteOption {
    breadcrumb?: BreadcrumbValue;
  }
}

// `AnyRouteMatch.params` is typed as `any`. TanStack guarantees the shape
// matches the file-route path segments, so breadcrumb callers can narrow it
// via this helper instead of casting inline (which trips
// `no-unsafe-type-assertion`).
export function routeParams<T>(match: AnyRouteMatch): T {
  const params: T = match.params;
  return params;
}

export function resolveCrumbs(match: AnyRouteMatch): BreadcrumbCrumb[] {
  const raw = match.staticData.breadcrumb;
  if (!raw) return [];

  const resolved = typeof raw === 'function' ? raw(match) : raw;
  if (!resolved) return [];

  if (typeof resolved === 'string') {
    return [{ label: resolved, to: match.pathname }];
  }
  if (Array.isArray(resolved)) return resolved;
  return [resolved];
}

export const Breadcrumbs: React.FC = () => {
  const matches = useMatches();
  const crumbs = matches.flatMap(resolveCrumbs);

  if (crumbs.length === 0) return null;

  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((crumb, i) => {
          const isLast = i === crumbs.length - 1;
          return (
            <Fragment
              key={`${i}-${typeof crumb.label === 'string' ? crumb.label : ''}`}
            >
              <BreadcrumbItem>
                {isLast || !crumb.to ? (
                  <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link to={crumb.to}>{crumb.label}</Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!isLast && <BreadcrumbSeparator />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
};
