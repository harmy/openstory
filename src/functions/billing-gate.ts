/**
 * Billing Gate Server Function
 * Combined endpoint returning balance + BYOK status for billing gate checks
 */

import { createServerFn } from '@tanstack/react-start';
import { authWithTeamMiddleware } from './middleware';
import { isStripeEnabled } from '@/lib/billing/constants';
import { microsToUsd } from '@/lib/billing/money';

/**
 * Check billing gate status: balance, BYOK keys, and auto-top-up
 * Uses member-level auth (not admin-only like checkApiKeyStatusFn)
 */
export const getBillingGateStatusFn = createServerFn({ method: 'GET' })
  .middleware([authWithTeamMiddleware])
  .handler(async ({ context }) => {
    const { scopedDb } = context;

    const [
      balance,
      hasFalKey,
      hasOpenRouterKey,
      billingSettings,
      hasRedeemedGift,
    ] = await Promise.all([
      scopedDb.billing.getBalance(),
      scopedDb.apiKeys.hasKey('fal'),
      scopedDb.apiKeys.hasKey('openrouter'),
      scopedDb.billing.getBillingSettings(),
      scopedDb.billing.hasRedeemedGiftCode(),
    ]);

    return {
      hasCredits: balance > 0,
      hasFalKey,
      hasOpenRouterKey,
      balance: microsToUsd(balance),
      hasAutoTopUp:
        billingSettings.autoTopUpEnabled && !!billingSettings.stripeCustomerId,
      stripeEnabled: isStripeEnabled(),
      hasRedeemedGift,
    };
  });
