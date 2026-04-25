/**
 * Credit Balance Sidebar Row
 * Shows credit balance as a sidebar nav row. Visible when:
 * 1. Low balance with no safety net (amber warning)
 * 2. Balance topped up — stays until credits are drawn down (green)
 * 3. User toggled "always show" in credits page (neutral)
 */

import { cn } from '@/lib/utils';
import {
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useBalanceFlash } from '@/hooks/use-balance-flash';
import { useBillingBalance } from '@/hooks/use-billing-balance';
import { useBillingGateQuery } from '@/hooks/use-billing-gate';
import { useShowBalance } from '@/hooks/use-show-balance';
import { Link } from '@tanstack/react-router';
import { Wallet } from 'lucide-react';

export const CreditBalancePill: React.FC = () => {
  const { balance, isLowBalance } = useBillingBalance();
  const { data: gateStatus } = useBillingGateQuery();
  const { showBalance } = useShowBalance();
  const { isFlashing } = useBalanceFlash();

  const hasSafetyNet =
    gateStatus?.hasAutoTopUp ||
    gateStatus?.hasFalKey ||
    gateStatus?.hasOpenRouterKey;

  const isLowBalanceVisible = isLowBalance && !hasSafetyNet;
  const isVisible = isLowBalanceVisible || showBalance || isFlashing;

  if (!isVisible) return null;

  // Flash (green) takes priority, then low-balance (amber), then neutral
  const colorClass = isFlashing
    ? 'text-emerald-600 dark:text-emerald-400'
    : isLowBalanceVisible
      ? 'text-amber-600 dark:text-amber-400'
      : '';

  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild tooltip="Credits">
        <Link to="/credits">
          <Wallet />
          <span>Credits</span>
        </Link>
      </SidebarMenuButton>
      <SidebarMenuBadge
        className={cn(
          'tabular-nums animate-[balance-flash-in_300ms_ease-out_both]',
          colorClass
        )}
      >
        ${balance?.toFixed(2) ?? '0.00'}
      </SidebarMenuBadge>
    </SidebarMenuItem>
  );
};
