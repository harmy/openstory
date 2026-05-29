/**
 * Generate Langfuse prompt configurations for all structured output Zod schemas
 * Run with: bun scripts/print-schemas.ts
 * Outputs to: scripts/schemas/*.json
 *
 * Generates Langfuse prompt configs with:
 * - name: Langfuse prompt name
 * - response_format: JSON schema for structured outputs
 *
 * Validates:
 * - Required field coverage for strict JSON schema
 * - Description coverage for AI structured outputs
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

// Import canonical schemas from the codebase
import { sceneAnalysisSchema } from '@/lib/ai/scene-analysis.schema';

// Import result schemas
import {
  characterExtractionResultSchema,
  locationExtractionResultSchema,
  motionPromptGenerationResultSchema,
  musicDesignResultSchema,
  sceneSplittingResultSchema,
  visualPromptGenerationResultSchema,
} from '@/lib/ai/response-schemas';
import {
  locationMatchResponseSchema,
  talentMatchResponseSchema,
} from '@/lib/ai/response-schemas';

const SCHEMA_OUTPUT_DIR = join(import.meta.dirname, 'schemas');

// All result schemas are now imported from their source files

// Helper to generate Langfuse config and write to file
async function generateLangfuseConfig(phaseName: string, schema: z.ZodTypeAny) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`LANGFUSE CONFIG: ${phaseName}`);
  console.log('='.repeat(80));

  const jsonSchema = z.toJSONSchema(schema);

  // Generate Langfuse prompt configuration
  const langfuseConfig = {
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: phaseName.replace(/[^a-zA-Z0-9_]/g, '_'), // Convert phase name to valid schema name
        schema: jsonSchema,
        strict: true,
      },
    },
  };

  console.log(JSON.stringify(langfuseConfig, null, 2));

  // Write to file
  const filePath = join(SCHEMA_OUTPUT_DIR, `${phaseName}.json`);
  await writeFile(filePath, JSON.stringify(langfuseConfig, null, 2));
  console.log(`\n📁 Written to: ${filePath}`);

  // Check for properties without required
  checkRequiredFields(jsonSchema, phaseName);

  // Check for missing descriptions
  console.log('\n📝 Checking descriptions:');
  const missingDescriptions = checkDescriptions(jsonSchema, phaseName);
  if (missingDescriptions === 0) {
    console.log('   ✅ All properties have descriptions');
  } else {
    console.log(`   ❌ ${missingDescriptions} properties missing descriptions`);
  }
}

function isObjectWithProperties(
  value: unknown
): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function checkRequiredFields(schema: unknown, path: string) {
  if (!isObjectWithProperties(schema)) return;

  if (schema.type === 'object' && isObjectWithProperties(schema.properties)) {
    const properties = schema.properties;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((r): r is string => typeof r === 'string')
      : [];
    const propertyNames = Object.keys(properties);
    const missing = propertyNames.filter((p) => !required.includes(p));

    if (missing.length > 0) {
      console.log(`\n⚠️  WARNING at ${path}:`);
      console.log(`   Properties not in 'required': ${missing.join(', ')}`);
      console.log(`   This will fail strict JSON schema validation!`);
    }

    // Recurse into properties
    for (const [key, value] of Object.entries(properties)) {
      checkRequiredFields(value, `${path}.${key}`);
    }
  }

  if (schema.items) {
    checkRequiredFields(schema.items, `${path}[]`);
  }
}

/**
 * Check for missing descriptions in JSON schema properties.
 * Descriptions help AI models understand the expected data format.
 */
function checkDescriptions(schema: unknown, path: string): number {
  let missingCount = 0;

  if (!isObjectWithProperties(schema)) return missingCount;

  if (schema.type === 'object' && isObjectWithProperties(schema.properties)) {
    const properties = schema.properties;

    for (const [key, value] of Object.entries(properties)) {
      if (
        isObjectWithProperties(value) &&
        !('description' in value && value.description)
      ) {
        console.log(`   ⚠️  Missing description: ${path}.${key}`);
        missingCount++;
      }
      missingCount += checkDescriptions(value, `${path}.${key}`);
    }
  }

  if (schema.items) {
    missingCount += checkDescriptions(schema.items, `${path}[]`);
  }

  return missingCount;
}

// Main
async function main() {
  console.log(
    '\n🔍 Generating Langfuse prompt configurations from imported result schemas...\n'
  );

  // Create output directory
  await mkdir(SCHEMA_OUTPUT_DIR, { recursive: true });

  // Generate Langfuse configs for all phase schemas
  await generateLangfuseConfig(
    'phase-1-scene-splitting',
    sceneSplittingResultSchema
  );
  await generateLangfuseConfig(
    'phase-2-character-extraction',
    characterExtractionResultSchema
  );
  await generateLangfuseConfig(
    'phase-2c-location-matching',
    locationMatchResponseSchema
  );
  await generateLangfuseConfig(
    'phase-3-visual-prompts',
    visualPromptGenerationResultSchema
  );
  await generateLangfuseConfig(
    'phase-4-motion-prompts',
    motionPromptGenerationResultSchema
  );
  await generateLangfuseConfig('phase-7-music-design', musicDesignResultSchema);
  await generateLangfuseConfig(
    'phase-6-talent-matching',
    talentMatchResponseSchema
  );
  await generateLangfuseConfig(
    'phase-2b-location-extraction',
    locationExtractionResultSchema
  );

  // Generate canonical schema for reference (raw JSON schema, not Langfuse config)
  await generateLangfuseConfig('canonical-scene-analysis', sceneAnalysisSchema);

  console.log('\n\n' + '='.repeat(80));
  console.log('SUMMARY');
  console.log('='.repeat(80));
  console.log(`
Langfuse prompt configurations generated with structured output schemas.

For strict JSON schema validation (Azure/OpenRouter/GPT-mini), ALL properties
in an object must be listed in the 'required' array.

Zod modifiers that cause issues:
  - .optional()  → property not in 'required' (GPT-mini fails)
  - .nullish()   → property not in 'required'

Safe alternatives:
  - .catch(defaultValue)  → property IS in 'required', has default
  - .nullable().catch(null) → property IS in 'required', allows null

For AI structured outputs, use .meta({ description: '...' }) on all fields
to help the model understand the expected data format.

Langfuse config files written to: ${SCHEMA_OUTPUT_DIR}/
Use these configs to create chat prompts in Langfuse dashboard.
`);
}

main().catch(console.error);
