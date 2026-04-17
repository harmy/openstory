/**
 * Registry of AI models available for script analysis.
 * Ordered by qualityRank (1 = best). Open-source models noted with license field.
 */

export const SCRIPT_ANALYSIS_MODELS = [
  {
    id: 'x-ai/grok-4.1-fast',
    name: 'Grok 4.1 Fast',
    provider: 'xAI',
    license: 'proprietary' as const,
    qualityRank: 1,
    contextWindow: 2_000_000,
    description: 'Fast agentic model with 2M context',
  },
  {
    id: 'anthropic/claude-sonnet-4.6',
    name: 'Claude Sonnet 4.6',
    provider: 'Anthropic',
    license: 'proprietary' as const,
    qualityRank: 2,
    contextWindow: 1_000_000,
    description: 'State-of-the-art coding and structured output',
  },
  {
    id: 'x-ai/grok-4.20-beta',
    name: 'Grok 4.2',
    provider: 'xAI',
    license: 'proprietary' as const,
    qualityRank: 3,
    contextWindow: 2_000_000,
    description: 'Lowest hallucination rate, flagship agentic model',
  },
  {
    id: 'anthropic/claude-opus-4.6',
    name: 'Claude Opus 4.6',
    provider: 'Anthropic',
    license: 'proprietary' as const,
    qualityRank: 4,
    contextWindow: 1_000_000,
    description: 'Frontier reasoning and coding',
  },
  {
    id: 'mistralai/mistral-small-2603',
    name: 'Mistral Small 4',
    provider: 'Mistral',
    license: 'open-source' as const,
    qualityRank: 5,
    contextWindow: 262_144,
    description: 'Apache 2.0, 119B MoE, multimodal + agentic coding',
  },
  {
    id: 'deepseek/deepseek-v3.2',
    name: 'DeepSeek V3.2',
    provider: 'DeepSeek',
    license: 'open-source' as const,
    qualityRank: 6,
    contextWindow: 163_840,
    description: 'MIT license, MMLU 94.2, GPT-5 class reasoning',
  },
  {
    id: 'z-ai/glm-5',
    name: 'GLM-5',
    provider: 'Z.ai',
    license: 'open-source' as const,
    qualityRank: 7,
    contextWindow: 202_752,
    description: 'MIT license, 744B MoE, SWE-bench 77.8',
  },
  {
    id: 'google/gemini-3.1-pro-preview',
    name: 'Gemini 3.1 Pro',
    provider: 'Google',
    license: 'proprietary' as const,
    qualityRank: 8,
    contextWindow: 1_048_576,
    description: 'Frontier multimodal reasoning with 1M context',
  },
  {
    id: 'openai/gpt-5.4',
    name: 'GPT-5.4',
    provider: 'OpenAI',
    license: 'proprietary' as const,
    qualityRank: 9,
    contextWindow: 1_050_000,
    description: 'Latest GPT-5 series with 1M context',
  },
  {
    id: 'google/gemini-3-flash-preview',
    name: 'Gemini 3 Flash',
    provider: 'Google',
    license: 'proprietary' as const,
    qualityRank: 10,
    contextWindow: 1_048_576,
    description: 'Fast multimodal with 1M context',
  },
  {
    id: 'openai/gpt-5.4-mini',
    name: 'GPT-5.4 Mini',
    provider: 'OpenAI',
    license: 'proprietary' as const,
    qualityRank: 11,
    contextWindow: 400_000,
    description: 'Fast reasoning with configurable effort modes',
  },
  {
    id: 'bytedance-seed/seed-2.0-mini',
    name: 'Seed 2.0 Mini',
    provider: 'ByteDance',
    license: 'proprietary' as const,
    qualityRank: 12,
    contextWindow: 262_144,
    description: 'Fast multimodal with 4 reasoning effort modes',
  },
  {
    id: 'openai/gpt-5.4-nano',
    name: 'GPT-5.4 Nano',
    provider: 'OpenAI',
    license: 'proprietary' as const,
    qualityRank: 13,
    contextWindow: 400_000,
    description: 'Fastest and most cost-efficient GPT-5.4 variant',
  },
] as const;

type AnalysisModel = (typeof SCRIPT_ANALYSIS_MODELS)[number];
export type AnalysisModelId = AnalysisModel['id'];

/**
 * Get model by ID
 */
export function getAnalysisModelById(id: string): AnalysisModel | undefined {
  return SCRIPT_ANALYSIS_MODELS.find((model) => model.id === id);
}

/**
 * Runtime validation: Check if a string is a valid AnalysisModelId
 * @param value - String value to validate
 * @returns true if value is a valid model ID, false otherwise
 */
export function isValidAnalysisModelId(
  value: unknown
): value is AnalysisModelId {
  return (
    typeof value === 'string' &&
    SCRIPT_ANALYSIS_MODELS.some((model) => model.id === value)
  );
}

/**
 * Get all model IDs
 */
export function getAllModelIds(): AnalysisModelId[] {
  return SCRIPT_ANALYSIS_MODELS.map((model) => model.id);
}

export const ANALYSIS_MODEL_IDS = getAllModelIds();

/**
 * Get context window size (in tokens) for a model
 */
export function getContextWindow(modelId: string): number {
  const model = SCRIPT_ANALYSIS_MODELS.find((m) => m.id === modelId);
  return model?.contextWindow ?? 128_000;
}
/**
 * Default model to use when none is specified
 */
export const DEFAULT_ANALYSIS_MODEL: AnalysisModelId = 'x-ai/grok-4.1-fast';

/**
 * Image generation models are now in src/lib/ai/models.ts
 * Use IMAGE_MODELS, TextToImageModelId, and related helpers from there instead.
 * @deprecated Import from @/lib/ai/models instead
 */
