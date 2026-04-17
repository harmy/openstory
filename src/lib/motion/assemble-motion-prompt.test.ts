import { describe, expect, it } from 'bun:test';
import type { MotionPrompt } from '../ai/scene-analysis.schema';
import { assembleMotionPrompt } from './assemble-motion-prompt';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const baseComponents: MotionPrompt['components'] = {
  cameraMovement: 'slow dolly forward',
  startPosition: 'medium shot of character at desk',
  endPosition: 'close-up on character face',
  durationSeconds: 8,
  speed: 'slow',
  smoothness: 'smooth',
  subjectTracking: 'Maintains focus on character face',
  equipment: 'Steadicam',
};

const baseParameters: MotionPrompt['parameters'] = {
  durationSeconds: 8,
  fps: 30,
  motionAmount: 'medium',
  cameraControl: { pan: 0, tilt: 0, zoom: 1.2, movement: 'forward' },
};

const dialogueWithTone: NonNullable<MotionPrompt['dialogue']> = {
  presence: true,
  lines: [
    {
      character: 'Sarah',
      line: 'We need to reconsider the entire approach.',
      tone: 'firm commanding',
    },
    {
      character: 'James',
      line: "I couldn't agree more.",
      tone: 'soft resigned',
    },
  ],
};

const audioData: NonNullable<MotionPrompt['audio']> = {
  ambientSound: 'quiet office hum with keyboard clicks',
  soundEffects: ['chair scrape', 'paper rustling'],
};

const fullPromptText =
  'Steadicam slow dolly forward from medium shot to close-up.\n\nSarah speaks firmly while gesturing. James nods in agreement.\n\nSubtle office sounds, papers flutter.';

function makeMotionPrompt(overrides: Partial<MotionPrompt> = {}): MotionPrompt {
  return {
    fullPrompt: fullPromptText,
    components: baseComponents,
    parameters: baseParameters,
    dialogue: dialogueWithTone,
    audio: audioData,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Kling v3 Pro (audio-capable — default model)
// ---------------------------------------------------------------------------

describe('assembleMotionPrompt', () => {
  describe('Kling v3 Pro (audio)', () => {
    const model = 'kling_v3_pro';

    it('starts with the fullPrompt as the base', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toStartWith(fullPromptText);
    });

    it('appends character labels with tone and dialogue text', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toContain(
        '[Sarah, firm commanding]: "We need to reconsider the entire approach."'
      );
      expect(result).toContain(
        '[James, soft resigned]: "I couldn\'t agree more."'
      );
    });

    it('uses temporal markers between dialogue lines', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toContain('Immediately,');
    });

    it('appends ambient sound descriptions', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toContain('Ambient sounds:');
      expect(result).toContain('quiet office hum');
      expect(result).toContain('chair scrape');
    });

    it('omits dialogue section when not present', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          dialogue: { presence: false, lines: [] },
        }),
        model,
      });

      expect(result).not.toContain('[Sarah');
      // Still has fullPrompt + audio
      expect(result).toStartWith(fullPromptText);
      expect(result).toContain('Ambient sounds:');
    });

    it('omits audio section when no audio data', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({ audio: undefined }),
        model,
      });

      expect(result).not.toContain('Ambient sounds:');
      // Still has fullPrompt + dialogue
      expect(result).toContain('[Sarah');
    });
  });

  // ---------------------------------------------------------------------------
  // Google Veo 3.1 (audio-capable)
  // ---------------------------------------------------------------------------

  describe('Google Veo 3.1 (audio)', () => {
    const model = 'veo3_1';

    it('starts with fullPrompt as the base', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toStartWith(fullPromptText);
    });

    it('appends dialogue as natural narrative with inline quotes', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toContain(
        'Sarah says in a firm commanding voice, "We need to reconsider the entire approach."'
      );
      expect(result).toContain('James says in a soft resigned voice,');
    });

    it('appends Audio: section with ambient and SFX', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toContain('Audio:');
      expect(result).toContain('quiet office hum');
      expect(result).toContain('chair scrape');
    });

    it('omits Audio: section when no audio data', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({ audio: undefined }),
        model,
      });

      expect(result).not.toContain('Audio:');
    });

    it('omits dialogue when not present', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          dialogue: { presence: false, lines: [] },
        }),
        model,
      });

      expect(result).not.toContain('Sarah says');
      expect(result).toStartWith(fullPromptText);
    });
  });

  // ---------------------------------------------------------------------------
  // Non-audio models (Grok, MiniMax)
  // ---------------------------------------------------------------------------

  describe('Grok Imagine Video (no audio)', () => {
    const model = 'grok_imagine_video';

    it('returns fullPrompt for non-audio model', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toBe(fullPromptText);
    });
  });

  describe('MiniMax Hailuo 02 (no audio)', () => {
    const model = 'minimax_hailuo_02';

    it('returns fullPrompt for non-audio model', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt(),
        model,
      });

      expect(result).toBe(fullPromptText);
    });
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  describe('edge cases', () => {
    it('handles dialogue lines without tone', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          dialogue: {
            presence: true,
            lines: [{ character: 'Sarah', line: 'Hello.', tone: '' }],
          },
        }),
        model: 'kling_v3_pro',
      });

      // No tone → no tone suffix in Kling label
      expect(result).toContain('[Sarah]: "Hello."');
    });

    it('handles narrator (empty character)', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          dialogue: {
            presence: true,
            lines: [
              { character: '', line: 'It was a dark night.', tone: 'somber' },
            ],
          },
        }),
        model: 'kling_v3_pro',
      });

      expect(result).toContain('[Narrator, somber]: "It was a dark night."');
    });

    it('handles audio with only ambient sound', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          audio: { ambientSound: 'rain on windows', soundEffects: [] },
        }),
        model: 'veo3_1',
      });

      expect(result).toContain('Audio: rain on windows');
    });

    it('handles audio with only sound effects', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          audio: { ambientSound: '', soundEffects: ['door slam'] },
        }),
        model: 'veo3_1',
      });

      expect(result).toContain('Audio: door slam');
    });

    it('handles empty audio (no ambient, no SFX)', () => {
      const result = assembleMotionPrompt({
        motionPrompt: makeMotionPrompt({
          audio: { ambientSound: '', soundEffects: [] },
        }),
        model: 'veo3_1',
      });

      // No Audio: section when both are empty
      expect(result).not.toContain('Audio:');
    });
  });
});
