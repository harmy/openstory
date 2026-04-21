import { cn } from '@/lib/utils';
import type * as React from 'react';
import { Header } from './header';
import { InvalidApiKeyBanner } from './invalid-api-key-banner';

interface AppLayoutProps extends React.HTMLAttributes<HTMLElement> {}

export const AppLayout: React.FC<AppLayoutProps> = ({
  className,
  children,
  ...props
}) => {
  return (
    <div className="flex flex-col h-screen bg-background">
      <Header />
      <InvalidApiKeyBanner />
      <main
        className={cn(
          'flex flex-col flex-1 overflow-y-auto [scrollbar-gutter:stable]',
          className
        )}
        {...props}
      >
        {children}
      </main>
    </div>
  );
};
