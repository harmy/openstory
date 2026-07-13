import { micros, usdToMicros } from '../money';
import { describe, expect, it } from 'vitest';
import {
  formatProcessingFeePercent,
  processingFeeUsd,
  splitCheckoutAmounts,
  totalCheckoutCents,
  totalCheckoutUsd,
} from '../constants';

describe('billing constants', () => {
  it('applies processing fee only at purchase', () => {
    expect(processingFeeUsd(100)).toBe(5);
    expect(totalCheckoutUsd(100)).toBe(105);
    expect(formatProcessingFeePercent()).toBe('5%');
  });

  it('splits checkout into credit and fee line items', () => {
    expect(splitCheckoutAmounts(100)).toEqual({
      creditUsd: 100,
      feeUsd: 5,
      totalUsd: 105,
    });
  });

  it('rounds fee to cents for Stripe', () => {
    expect(splitCheckoutAmounts(10)).toEqual({
      creditUsd: 10,
      feeUsd: 0.5,
      totalUsd: 10.5,
    });
  });

  it('rounds fee from credit cents, not float USD', () => {
    expect(splitCheckoutAmounts(10.01)).toEqual({
      creditUsd: 10.01,
      feeUsd: 0.5,
      totalUsd: 10.51,
    });
  });

  it('totalCheckoutCents returns integer cents aligned with splitCheckoutAmounts', () => {
    expect(totalCheckoutCents(usdToMicros(100))).toBe(10_500);
    expect(totalCheckoutCents(usdToMicros(10))).toBe(1_050);
    expect(totalCheckoutCents(micros(10_500_000))).toBe(1_103);
    expect(Number.isInteger(totalCheckoutCents(micros(10_010_000)))).toBe(true);
  });
});
