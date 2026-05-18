import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

const mockCapture = mock();
const mockGetClient: ReturnType<
  typeof mock<() => { capture: typeof mockCapture } | null>
> = mock(() => ({ capture: mockCapture }));

mock.module('@/lib/posthog-server', () => ({
  getPostHogClient: mockGetClient,
}));

const { bumpStylePopularity } = await import('./bump-style-popularity');

const baseArgs = {
  styleId: 'style_01',
  sequenceIds: ['seq_01'],
  teamId: 'team_01',
  userId: 'user_01',
};

describe('bumpStylePopularity', () => {
  beforeEach(() => {
    mockCapture.mockClear();
    mockGetClient.mockReset();
    mockGetClient.mockImplementation(() => ({ capture: mockCapture }));
  });

  it('calls incrementUsage exactly once with the styleId', () => {
    const incrementUsage = mock(() => Promise.resolve());
    bumpStylePopularity({
      ...baseArgs,
      scopedDb: { styles: { incrementUsage } },
    });
    expect(incrementUsage).toHaveBeenCalledTimes(1);
    expect(incrementUsage).toHaveBeenCalledWith('style_01');
  });

  it('captures style_selected exactly once when posthog is configured', () => {
    bumpStylePopularity({
      ...baseArgs,
      scopedDb: { styles: { incrementUsage: mock(() => Promise.resolve()) } },
    });
    expect(mockCapture).toHaveBeenCalledTimes(1);
    expect(mockCapture).toHaveBeenCalledWith({
      distinctId: 'user_01',
      event: 'style_selected',
      properties: {
        styleId: 'style_01',
        sequenceIds: ['seq_01'],
        teamId: 'team_01',
      },
    });
  });

  it('skips posthog when no client is configured', () => {
    mockGetClient.mockReturnValueOnce(null);
    bumpStylePopularity({
      ...baseArgs,
      scopedDb: { styles: { incrementUsage: mock(() => Promise.resolve()) } },
    });
    expect(mockCapture).not.toHaveBeenCalled();
  });

  it('does not throw or reject when incrementUsage rejects', async () => {
    const err = new Error('db down');
    const incrementUsage = mock(() => Promise.reject(err));
    const errorSpy = spyOn(console, 'error').mockImplementation(() => {});

    try {
      // Synchronous call must not throw.
      expect(() =>
        bumpStylePopularity({
          ...baseArgs,
          scopedDb: { styles: { incrementUsage } },
        })
      ).not.toThrow();

      // Let microtasks flush so the .catch handler runs.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(errorSpy).toHaveBeenCalledWith(
        '[styles] incrementUsage failed',
        expect.objectContaining({
          styleId: 'style_01',
          teamId: 'team_01',
          userId: 'user_01',
          sequenceCount: 1,
          err,
        })
      );
    } finally {
      errorSpy.mockRestore();
    }
  });
});
