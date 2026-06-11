/**
 * Billing Constants
 * Central configuration for the credits/wallet billing system
 */

import { getEnv } from '#env';
import { type Microdollars, usdToMicros, multiplyMicros } from './money';

/** Whether Stripe payment processing is available (checkout, webhooks, auto-top-up). */
export function isStripeEnabled(): boolean {
  return !!getEnv().STRIPE_SECRET_KEY;
}

/** Markup percentage applied on top of provider costs (e.g., 0.05 = 5%) */
const BILLING_MARKUP_PERCENT = 0.05;

/** Minimum top-up amount in USD */
export const MIN_TOPUP_AMOUNT_USD = 10;

/** Minimum top-up amount in microdollars */
export const MIN_TOPUP_AMOUNT_MICROS: Microdollars =
  usdToMicros(MIN_TOPUP_AMOUNT_USD);

/** Preset top-up amounts shown on the billing page */
export const PRESET_TOPUP_AMOUNTS_USD = [10, 100, 1000] as const;

/** Low balance warning threshold in USD (used when auto-top-up is disabled) */
export const LOW_BALANCE_THRESHOLD_USD = 5;

/** Minimum time between auto-top-up charges in milliseconds (60 seconds) */
export const AUTO_TOPUP_COOLDOWN_MS = 60_000;

/** Number of months before credit batches expire */
const CREDIT_EXPIRY_MONTHS = 12;

/** Calculate the expiry date for a credit batch */
export function calculateExpiryDate(from?: Date): Date {
  const date = new Date(from ?? Date.now());
  date.setMonth(date.getMonth() + CREDIT_EXPIRY_MONTHS);
  return date;
}

/**
 * Apply markup to a raw provider cost in microdollars
 * @param rawCostMicros - The raw cost from the provider in microdollars
 * @returns The cost with markup applied, in microdollars
 */
export function applyMarkup(rawCostMicros: Microdollars): Microdollars {
  return multiplyMicros(rawCostMicros, 1 + BILLING_MARKUP_PERCENT);
}
