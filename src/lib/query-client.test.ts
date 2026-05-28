import { MutationObserver } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeQueryClient } from './query-client';

describe('MutationCache', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('invalidates matching queries when mutation has a mutationKey', async () => {
    const qc = makeQueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const observer = new MutationObserver(qc, {
      mutationKey: ['items', 'org-1'],
      mutationFn: () => Promise.resolve('ok'),
    });
    await observer.mutate();

    expect(spy).toHaveBeenCalledWith({
      queryKey: ['items', 'org-1'],
    });
  });

  it('invalidates ALL queries when mutation has no mutationKey', async () => {
    const qc = makeQueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const observer = new MutationObserver(qc, {
      mutationFn: () => Promise.resolve('ok'),
    });
    await observer.mutate();

    expect(spy).toHaveBeenCalledWith({
      queryKey: undefined,
    });
  });

  it('uses the correct key for each mutation', async () => {
    const qc = makeQueryClient();
    const spy = vi.spyOn(qc, 'invalidateQueries');

    const first = new MutationObserver(qc, {
      mutationKey: ['categories', 'org-1'],
      mutationFn: () => Promise.resolve('a'),
    });
    await first.mutate();

    const second = new MutationObserver(qc, {
      mutationKey: ['items', 'org-1'],
      mutationFn: () => Promise.resolve('b'),
    });
    await second.mutate();

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(1, {
      queryKey: ['categories', 'org-1'],
    });
    expect(spy).toHaveBeenNthCalledWith(2, { queryKey: ['items', 'org-1'] });
  });
});
