import { vi } from 'vitest';

// Import real exports before vi.doMock so they can be re-exported
import * as tanstackAi from '@tanstack/ai';
import * as tanstackAiFal from '@tanstack/ai-fal';

export const mockGenerateVideo = vi.fn();
export const mockGetVideoJobStatus = vi.fn();
export const mockFalVideo = vi.fn(() => ({
  kind: 'video',
  name: 'fal',
  model: 'mock-model',
}));

vi.doMock('@tanstack/ai', () => ({
  ...tanstackAi,
  generateVideo: mockGenerateVideo,
  getVideoJobStatus: mockGetVideoJobStatus,
}));

vi.doMock('@tanstack/ai-fal', () => ({
  ...tanstackAiFal,
  falVideo: mockFalVideo,
  falImage: vi.fn(() => ({ kind: 'image', name: 'fal', model: 'mock-model' })),
}));
