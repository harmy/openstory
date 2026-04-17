/**
 * Billing Gate Hook
 * Combines balance + BYOK status to gate credit-consuming actions
 */

import { useQuery } from '@tanstack/react-query';
import { useSession } from '@/lib/auth/client';
import { getBillingGateStatusFn } from '@/functions/billing-gate';
import { useState, useCallback } from 'react';

export const BILLING_GATE_KEY = ['billing-gate-byok'] as const;

type BillingGateStatus = {
  hasCredits: boolean;
  hasFalKey: boolean;
  hasOpenRouterKey: boolean;
  balance: number;
  hasAutoTopUp: boolean;
  stripeEnabled: boolean;
  hasRedeemedGift: boolean;
};

export function useBillingGateQuery() {
  const { data: session } = useSession();

  return useQuery({
    queryKey: [...BILLING_GATE_KEY],
    queryFn: () => getBillingGateStatusFn(),
    staleTime: 60_000,
    enabled: !!session,
  });
}

/**
 * Check if BYOK keys cover the required providers.
 *
 * - 'all': team has both fal + openrouter keys (sequence creation)
 * - 'fal': team has fal key (image/motion generation)
 */
function hasByokCoverage(
  data: BillingGateStatus,
  mode: 'all' | 'fal'
): boolean {
  if (mode === 'fal') return data.hasFalKey;
  return data.hasFalKey && data.hasOpenRouterKey;
}

/**
 * Gate for credit-consuming actions.
 *
 * @param mode - 'all' requires both fal + openrouter BYOK keys to bypass credits.
 *               'fal' only requires fal key (default).
 */
export function useBillingGate(mode: 'all' | 'fal' = 'all') {
  const query = useBillingGateQuery();
  const [open, setOpen] = useState(false);

  const data: BillingGateStatus | undefined = query.data;

  const canGenerate = data
    ? data.hasCredits || hasByokCoverage(data, mode) || data.hasAutoTopUp
    : true; // Don't block while loading

  const needsBillingSetup = data
    ? !data.hasCredits && !hasByokCoverage(data, mode) && !data.hasAutoTopUp
    : false;

  const showGate = useCallback(() => setOpen(true), []);

  return {
    canGenerate,
    needsBillingSetup,
    hasFalKey: data?.hasFalKey ?? false,
    hasOpenRouterKey: data?.hasOpenRouterKey ?? false,
    hasCredits: data?.hasCredits ?? true,
    hasAutoTopUp: data?.hasAutoTopUp ?? false,
    stripeEnabled: data?.stripeEnabled ?? true,
    hasRedeemedGift: data?.hasRedeemedGift ?? false,
    showGate,
    gateProps: { open, onOpenChange: setOpen },
    isLoading: query.isLoading,
  };
}

/**
 * Gate for image/motion generation (only needs fal.ai BYOK key to bypass credits)
 */
export function useFalBillingGate() {
  return useBillingGate('fal');
}
