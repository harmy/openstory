import { describe, expect, test } from 'bun:test';
import { sceneAnalysisExample } from './scene-analysis.example';
import { sceneAnalysisSchema } from './scene-analysis.schema';

describe('Scene Analysis Schema Validation', () => {
  test('example data conforms to schema', () => {
    const result = sceneAnalysisSchema.safeParse(sceneAnalysisExample);

    if (!result.success) {
      console.error(
        'Validation errors:',
        JSON.stringify(result.error.format(), null, 2)
      );
    }

    expect(result.success).toBe(true);
  });

  test('example has correct structure', () => {
    expect(sceneAnalysisExample.status).toBe('success');
    expect(sceneAnalysisExample.scenes).toHaveLength(1);
    expect(sceneAnalysisExample.characterBible).toHaveLength(1);
    expect(sceneAnalysisExample.projectMetadata).toBeDefined();
  });

  test('scenes have required fields', () => {
    for (const scene of sceneAnalysisExample.scenes) {
      expect(scene.sceneId).toBeDefined();
      expect(scene.sceneNumber).toBeGreaterThan(0);
      expect(scene.originalScript).toBeDefined();
      expect(scene.metadata).toBeDefined();
      expect(scene.prompts).toBeDefined();
      expect(scene.prompts?.visual).toBeDefined();
      expect(scene.prompts?.motion).toBeDefined();
    }
  });

  test('visual prompts have all required components', () => {
    for (const scene of sceneAnalysisExample.scenes) {
      if (!scene.prompts?.visual) continue;
      const { components } = scene.prompts.visual;
      expect(components.sceneDescription).toBeDefined();
      expect(components.subject).toBeDefined();
      expect(components.environment).toBeDefined();
      expect(components.lighting).toBeDefined();
      expect(components.camera).toBeDefined();
      expect(components.composition).toBeDefined();
      expect(components.style).toBeDefined();
      expect(components.technical).toBeDefined();
      expect(components.atmosphere).toBeDefined();
    }
  });

  test('motion prompts have all required components', () => {
    for (const scene of sceneAnalysisExample.scenes) {
      if (!scene.prompts?.motion) continue;
      const { components } = scene.prompts.motion;
      expect(components.cameraMovement).toBeDefined();
      expect(components.startPosition).toBeDefined();
      expect(components.endPosition).toBeDefined();
      expect(components.durationSeconds).toBeGreaterThan(0);
      expect(components.speed).toBeDefined();
      expect(components.smoothness).toBeDefined();
      expect(components.subjectTracking).toBeDefined();
      expect(components.equipment).toBeDefined();
    }
  });

  test('character bible entries have required fields', () => {
    for (const character of sceneAnalysisExample.characterBible) {
      expect(character.characterId).toBeDefined();
      expect(character.name).toBeDefined();
      expect(character.physicalDescription).toBeDefined();
      expect(character.standardClothing).toBeDefined();
      expect(character.consistencyTag).toBeDefined();
    }
  });
});
