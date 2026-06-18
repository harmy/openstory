import { describe, expect, it } from 'vitest';
import {
  analysisModelSupportsVision,
  getVisionCompanionModelId,
  resolveVisionModel,
  SCRIPT_ANALYSIS_MODELS,
} from '../models.config';

// GLM-5.2 is text-only but declares GLM-4.6V as its vision companion (#942):
// image-bearing calls must transparently swap to the companion.
describe('vision-model routing', () => {
  it('GLM-5.2 is text-only and points at GLM-4.6V as its companion', () => {
    expect(analysisModelSupportsVision('z-ai/glm-5.2')).toBe(false);
    expect(analysisModelSupportsVision('z-ai/glm-4.6v')).toBe(true);
    expect(getVisionCompanionModelId('z-ai/glm-5.2')).toBe('z-ai/glm-4.6v');
  });

  it('swaps a text-only model to its companion only when an image is present', () => {
    expect(resolveVisionModel('z-ai/glm-5.2', true)).toBe('z-ai/glm-4.6v');
    expect(resolveVisionModel('z-ai/glm-5.2', false)).toBe('z-ai/glm-5.2');
  });

  // The type system catches a typo'd companion id, but not a companion that
  // points at a real-yet-text-only model — assert the semantic invariant.
  it('every declared vision companion is itself a vision-capable model', () => {
    for (const model of SCRIPT_ANALYSIS_MODELS) {
      if ('visionCompanion' in model) {
        expect(analysisModelSupportsVision(model.visionCompanion)).toBe(true);
      }
    }
  });

  it('leaves vision-capable models and companionless text models unchanged', () => {
    // Already sees images — no swap.
    expect(resolveVisionModel('x-ai/grok-4.3', true)).toBe('x-ai/grok-4.3');
    // Text-only with no companion — stays put (caller drops the image).
    expect(resolveVisionModel('deepseek/deepseek-v3.2', true)).toBe(
      'deepseek/deepseek-v3.2'
    );
    expect(getVisionCompanionModelId('deepseek/deepseek-v3.2')).toBeUndefined();
  });
});
