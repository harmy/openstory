import { cn } from '@/lib/utils';
import type { FC, ReactNode } from 'react';

type RecommendStylesButtonShellProps = {
  /** When true, draw the bordered highlight around the trigger button. */
  recommended: boolean;
  children: ReactNode;
  className?: string;
};

/** Decorative border around the Recommend / Recommended styles trigger. */
export const RecommendStylesButtonShell: FC<
  RecommendStylesButtonShellProps
> = ({ recommended, children, className }) => {
  if (!recommended) return <>{children}</>;

  return (
    <div
      className={cn(
        'rounded-xl border border-primary/20',
        'bg-gradient-to-br from-primary/[0.06] via-primary/[0.02] to-transparent',
        'p-1 shadow-sm',
        className
      )}
    >
      {children}
    </div>
  );
};
