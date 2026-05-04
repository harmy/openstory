import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { Frame } from '@/types/database';
import { describe, expect, test } from 'bun:test';
import { generateChaptersVTT } from './generate-chapters';

// Helper to create minimal test scene metadata
const createTestScene = (overrides: Partial<Scene>): Scene => ({
  sceneId: 'test-scene',
  sceneNumber: 1,
  originalScript: { extract: '', dialogue: [] },
  ...overrides,
});

// Helper to create test frames with minimal required fields
const createTestFrame = (overrides: Partial<Frame>): Frame => ({
  id: '1',
  sequenceId: 'seq-1',
  orderIndex: 0,
  description: null,
  durationMs: 3000,
  videoUrl: null,
  videoPath: null,
  videoStatus: 'pending',
  thumbnailUrl: null,
  thumbnailPath: null,
  thumbnailStatus: 'pending',
  metadata: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  thumbnailWorkflowRunId: null,
  thumbnailGeneratedAt: null,
  thumbnailError: null,
  imageModel: 'nano_banana',
  imagePrompt: null,
  videoWorkflowRunId: null,
  videoGeneratedAt: null,
  variantImageUrl: null,
  variantImageStatus: 'pending',
  variantWorkflowRunId: null,
  variantImageGeneratedAt: null,
  variantImageError: null,
  videoError: null,
  motionModel: 'veo3',
  motionPrompt: null,
  audioUrl: null,
  audioPath: null,
  audioStatus: 'pending',
  audioWorkflowRunId: null,
  audioGeneratedAt: null,
  audioError: null,
  audioModel: null,
  thumbnailInputHash: null,
  variantImageInputHash: null,
  videoInputHash: null,
  audioInputHash: null,
  previewThumbnailUrl: null,
  ...overrides,
});

describe('generateChaptersVTT', () => {
  test('generates valid WebVTT chapters with metadata', () => {
    const frames: Frame[] = [
      createTestFrame({
        id: '1',
        durationMs: 5000,
        videoUrl: 'https://example.com/video1.mp4',
        videoStatus: 'completed',
        metadata: createTestScene({
          sceneNumber: 1,
          metadata: {
            title: 'Opening Scene',
            durationSeconds: 5,
            location: 'Beach',
            timeOfDay: 'morning',
            storyBeat: 'Introduction',
          },
        }),
      }),
      createTestFrame({
        id: '2',
        orderIndex: 1,
        durationMs: 3000,
        videoUrl: 'https://example.com/video2.mp4',
        videoStatus: 'completed',
        metadata: createTestScene({
          sceneNumber: 2,
          metadata: {
            title: 'Conflict Arises',
            durationSeconds: 3,
            location: 'Office',
            timeOfDay: 'afternoon',
            storyBeat: 'Rising action',
          },
        }),
      }),
    ];

    const vtt = generateChaptersVTT(frames);

    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('Scene 1: Opening Scene');
    expect(vtt).toContain('Scene 2: Conflict Arises');
    expect(vtt).toContain('00:00:00.000 --> 00:00:05.000');
    expect(vtt).toContain('00:00:05.000 --> 00:00:08.000');
  });

  test('handles frames without metadata', () => {
    const frames: Frame[] = [
      createTestFrame({
        id: '1',
        durationMs: 3000,
        videoUrl: 'https://example.com/video1.mp4',
        videoStatus: 'completed',
      }),
      createTestFrame({
        id: '2',
        orderIndex: 1,
        durationMs: 2000,
        videoUrl: 'https://example.com/video2.mp4',
        videoStatus: 'completed',
      }),
    ];

    const vtt = generateChaptersVTT(frames);

    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('Scene 1');
    expect(vtt).toContain('Scene 2');
  });

  test('defaults to 3 seconds when durationMs is null', () => {
    const frames: Frame[] = [
      createTestFrame({
        durationMs: null,
        videoUrl: 'https://example.com/video1.mp4',
        videoStatus: 'completed',
      }),
    ];

    const vtt = generateChaptersVTT(frames);

    expect(vtt).toContain('00:00:00.000 --> 00:00:03.000');
  });

  test('calculates cumulative time correctly', () => {
    const frames: Frame[] = [
      createTestFrame({
        id: '1',
        durationMs: 5000,
        videoUrl: 'https://example.com/video1.mp4',
        videoStatus: 'completed',
      }),
      createTestFrame({
        id: '2',
        orderIndex: 1,
        durationMs: 7000,
        videoUrl: 'https://example.com/video2.mp4',
        videoStatus: 'completed',
      }),
      createTestFrame({
        id: '3',
        orderIndex: 2,
        durationMs: 4000,
        videoUrl: 'https://example.com/video3.mp4',
        videoStatus: 'completed',
      }),
    ];

    const vtt = generateChaptersVTT(frames);

    // First chapter: 0-5 seconds
    expect(vtt).toContain('00:00:00.000 --> 00:00:05.000');
    // Second chapter: 5-12 seconds
    expect(vtt).toContain('00:00:05.000 --> 00:00:12.000');
    // Third chapter: 12-16 seconds
    expect(vtt).toContain('00:00:12.000 --> 00:00:16.000');
  });

  test('formats timestamps correctly for hours', () => {
    const frames: Frame[] = [
      createTestFrame({
        id: '1',
        durationMs: 3600000,
        videoUrl: 'https://example.com/video1.mp4',
        videoStatus: 'completed',
      }),
      createTestFrame({
        id: '2',
        orderIndex: 1,
        durationMs: 125000,
        videoUrl: 'https://example.com/video2.mp4',
        videoStatus: 'completed',
      }),
    ];

    const vtt = generateChaptersVTT(frames);

    expect(vtt).toContain('00:00:00.000 --> 01:00:00.000');
    expect(vtt).toContain('01:00:00.000 --> 01:02:05.000');
  });

  test('handles empty frames array', () => {
    const frames: Frame[] = [];

    const vtt = generateChaptersVTT(frames);

    expect(vtt).toContain('WEBVTT');
    expect(vtt).toContain('NOTE Generated chapters from frames');
    // Should not contain any chapter markers
    const lines = vtt.split('\n').filter((line) => line.includes('-->'));
    expect(lines).toHaveLength(0);
  });

  test('uses scene metadata for chapter titles', () => {
    const frames: Frame[] = [
      createTestFrame({
        durationMs: 3000,
        videoUrl: 'https://example.com/video1.mp4',
        videoStatus: 'completed',
        metadata: createTestScene({
          sceneNumber: 5,
          metadata: {
            title: 'The Great Revelation',
            durationSeconds: 3,
            location: 'Castle',
            timeOfDay: 'night',
            storyBeat: 'Climax',
          },
        }),
      }),
    ];

    const vtt = generateChaptersVTT(frames);

    expect(vtt).toContain('Scene 5: The Great Revelation');
  });

  test('escapes XSS vectors in scene titles', () => {
    const xssVectors = [
      {
        input: "<script>alert('XSS')</script>",
        expected: "&lt;script&gt;alert('XSS')&lt;/script&gt;",
      },
      {
        input: '<img src=x onerror=alert(1)>',
        expected: '&lt;img src=x onerror=alert(1)&gt;',
      },
      {
        input: 'Scene --> 00:05:00',
        expected: 'Scene —&gt; 00:05:00',
      },
      {
        input: 'Title with &amp; entity',
        expected: 'Title with &amp;amp; entity',
      },
      {
        input: 'Line one\nLine two',
        expected: 'Line one Line two',
      },
    ];

    for (const { input, expected } of xssVectors) {
      const frames: Frame[] = [
        createTestFrame({
          durationMs: 3000,
          metadata: createTestScene({
            sceneNumber: 1,
            metadata: {
              title: input,
              durationSeconds: 3,
              location: 'Test',
              timeOfDay: 'day',
              storyBeat: 'Test',
            },
          }),
        }),
      ];

      const vtt = generateChaptersVTT(frames);
      expect(vtt).toContain(`Scene 1: ${expected}`);
      expect(vtt).not.toContain(input !== expected ? input : '<<impossible>>');
    }
  });

  test('handles fractional seconds in timestamps', () => {
    const frames: Frame[] = [
      createTestFrame({
        durationMs: 1234, // 1.234 seconds
        videoUrl: 'https://example.com/video1.mp4',
        videoStatus: 'completed',
      }),
    ];

    const vtt = generateChaptersVTT(frames);

    expect(vtt).toContain('00:00:00.000 --> 00:00:01.234');
  });
});
