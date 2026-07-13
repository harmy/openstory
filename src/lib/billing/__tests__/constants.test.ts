import { describe, expect, it } from 'vitest';
import {
  formatProcessingFeePercent,
  processingFeeUsd,
  splitCheckoutAmounts,
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
});
