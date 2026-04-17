/**
 * Billing Gate Dialog
 * Prompts users to add credits or configure BYOK API keys
 */

import { XIcon } from '@/components/icons/x-icon';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { Link } from '@tanstack/react-router';
import { ArrowRight, CreditCard, Gift, KeyRound, Sparkles } from 'lucide-react';

const RETURN_KEY = 'openstory:billing-return';

function setReturnPath(returnTo?: string) {
  const path =
    returnTo ??
    (typeof window !== 'undefined' ? window.location.pathname : '/');
  localStorage.setItem(RETURN_KEY, path);
}

type OptionCardProps = {
  to?: string;
  href?: string;
  search?: Record<string, string>;
  icon: React.ReactNode;
  title: string;
  description: string;
  badge?: React.ReactNode;
  variant?: 'primary' | 'warm' | 'muted';
  onClick?: () => void;
  children?: React.ReactNode;
};

const cardClassName = (variant: 'primary' | 'warm' | 'muted') =>
  cn(
    'group relative flex items-center gap-3.5 rounded-xl border p-3.5 transition-all duration-200',
    variant === 'primary' &&
      'border-primary/20 bg-primary/[0.03] hover:border-primary/40 hover:bg-primary/[0.06]',
    variant === 'warm' &&
      'border-amber-500/20 bg-amber-500/[0.03] hover:border-amber-500/40 hover:bg-amber-500/[0.06] dark:border-amber-400/15 dark:bg-amber-400/[0.03] dark:hover:border-amber-400/30 dark:hover:bg-amber-400/[0.05]',
    variant === 'muted' &&
      'border-border/60 bg-transparent hover:border-border hover:bg-accent/50'
  );

const OptionCardContent: React.FC<
  Pick<
    OptionCardProps,
    'icon' | 'title' | 'description' | 'badge' | 'variant' | 'children'
  >
> = ({ icon, title, description, badge, variant = 'muted', children }) => (
  <>
    <div
      className={cn(
        'flex size-10 shrink-0 items-center justify-center rounded-lg transition-colors duration-200',
        variant === 'primary' &&
          'bg-primary/10 text-primary group-hover:bg-primary/15',
        variant === 'warm' &&
          'bg-amber-500/10 text-amber-600 group-hover:bg-amber-500/15 dark:text-amber-400',
        variant === 'muted' &&
          'bg-muted text-muted-foreground group-hover:bg-muted/80'
      )}
    >
      {icon}
    </div>
    <div className="flex-1 space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">{title}</span>
        {badge}
      </div>
      <p className="text-xs text-muted-foreground">{description}</p>
      {children}
    </div>
    <ArrowRight
      className={cn(
        'size-3.5 shrink-0 -translate-x-1 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-60',
        variant === 'muted' && 'text-muted-foreground'
      )}
    />
  </>
);

const OptionCard: React.FC<OptionCardProps> = ({
  to,
  href,
  search,
  icon,
  title,
  description,
  badge,
  variant = 'muted',
  onClick,
  children,
}) => {
  const content = (
    <OptionCardContent
      icon={icon}
      title={title}
      description={description}
      badge={badge}
      variant={variant}
    >
      {children}
    </OptionCardContent>
  );

  if (href) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        onClick={onClick}
        className={cardClassName(variant)}
      >
        {content}
      </a>
    );
  }

  return (
    <Link to={to ?? '/'} search={search} onClick={onClick}>
      <div className={cardClassName(variant)}>{content}</div>
    </Link>
  );
};

type BillingGateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasFalKey?: boolean;
  hasOpenRouterKey?: boolean;
  stripeEnabled?: boolean;
  returnTo?: string;
  context?: 'generation' | 'onboarding';
};

export const BillingGateDialog: React.FC<BillingGateDialogProps> = ({
  open,
  onOpenChange,
  hasFalKey = false,
  hasOpenRouterKey = false,
  stripeEnabled = true,
  returnTo,
  context = 'generation',
}) => {
  const byokPartial = hasFalKey || hasOpenRouterKey;

  const handleNav = () => {
    setReturnPath(returnTo);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {context === 'onboarding'
              ? 'Get started with OpenStory'
              : 'Set up billing to continue'}
          </DialogTitle>
          <DialogDescription>
            {context === 'onboarding'
              ? 'Set up billing to start creating video sequences.'
              : "This action uses AI credits. Choose how you'd like to proceed."}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 pt-1">
          <OptionCard
            href="https://x.com/openstory_so"
            icon={<XIcon className="size-4" />}
            title="Follow us on X"
            description="Follow @openstory_so and DM us for a $10 gift code"
            variant="primary"
            badge={
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                <Sparkles className="size-2.5" />
                Free credits
              </span>
            }
          />

          {stripeEnabled && (
            <OptionCard
              to="/credits"
              icon={<CreditCard className="size-4" />}
              title="Add Credits"
              description="Pay as you go. Auto top-up keeps you generating."
              variant="warm"
              onClick={handleNav}
            />
          )}

          <OptionCard
            to="/credits"
            search={{ tab: 'gift-codes' }}
            icon={<Gift className="size-4" />}
            title="Redeem Gift Code"
            description="Have a gift code? Redeem it to add credits instantly."
            variant="warm"
            onClick={handleNav}
          />

          <div className="flex items-center gap-3 py-1">
            <Separator className="flex-1" />
            <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/50">
              or
            </span>
            <Separator className="flex-1" />
          </div>

          <OptionCard
            to="/settings/api-keys"
            icon={<KeyRound className="size-4" />}
            title="Use Your Own API Keys"
            description="Connect fal.ai and OpenRouter. Pay providers directly."
            variant="muted"
            onClick={handleNav}
          >
            {byokPartial && (
              <div className="flex gap-1.5 pt-1">
                <Badge
                  variant={hasFalKey ? 'default' : 'secondary'}
                  className="px-1.5 py-0 text-[10px]"
                >
                  {hasFalKey ? 'fal.ai connected' : 'fal.ai needed'}
                </Badge>
                <Badge
                  variant={hasOpenRouterKey ? 'default' : 'secondary'}
                  className="px-1.5 py-0 text-[10px]"
                >
                  {hasOpenRouterKey
                    ? 'OpenRouter connected'
                    : 'OpenRouter needed'}
                </Badge>
              </div>
            )}
          </OptionCard>
        </div>

        <div className="pt-1">
          <Button
            variant="ghost"
            size="sm"
            className="w-full text-muted-foreground/70 hover:text-muted-foreground"
            onClick={() => onOpenChange(false)}
          >
            Set up later
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
