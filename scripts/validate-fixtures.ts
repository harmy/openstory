#!/usr/bin/env bun
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import {
  sceneSplittingResultSchema,
  talentMatchResponseSchema,
  locationMatchResponseSchema,
} from '@/lib/ai/response-schemas';
import { visualPromptWithContinuitySchema } from '@/lib/ai/scene-analysis.schema';

// Mirror script-enhancer.ts (not exported)
const EnhancedScriptSchema = z.object({
  enhanced_script: z.string(),
  style_stack_recommendation: z.object({
    recommended_style_stack: z.string(),
    reasoning: z.string(),
  }),
});

type Phase =
  | 'scene-split'
  | 'visual-prompt-scene'
  | 'script-enhance'
  | 'location-match'
  | 'talent-match'
  | 'unknown';

function classify(userMessage: string): Phase {
  if (userMessage.startsWith('Analyze the script within the USER_SCRIPT'))
    return 'scene-split';
  if (
    userMessage.startsWith('Generate the visual prompt for the starting frame')
  )
    return 'visual-prompt-scene';
  if (userMessage.startsWith('Please enhance this script for a short film'))
    return 'script-enhance';
  if (userMessage.startsWith('Match the following library locations'))
    return 'location-match';
  if (userMessage.startsWith('Cast the following talent'))
    return 'talent-match';
  return 'unknown';
}

const SCHEMAS: Record<Phase, z.ZodTypeAny | null> = {
  'scene-split': sceneSplittingResultSchema,
  'visual-prompt-scene': visualPromptWithContinuitySchema,
  'script-enhance': EnhancedScriptSchema,
  'location-match': locationMatchResponseSchema,
  'talent-match': talentMatchResponseSchema,
  unknown: null,
};

const dir = resolve(
  '/Users/tom/.claude/worktrees/openstory-657/e2e/fixtures/recorded'
);
const files = readdirSync(dir)
  .filter((f) => f.startsWith('openai-') && f.endsWith('.json'))
  .sort();

let pass = 0;
let fail = 0;
const failures: Array<{ file: string; phase: Phase; issues: string[] }> = [];

const fixtureFileSchema = z.object({
  fixtures: z.array(
    z.object({
      match: z.object({ userMessage: z.string().optional() }),
      response: z.object({ content: z.string().optional() }),
    })
  ),
});

for (const file of files) {
  const full = resolve(dir, file);
  const data = fixtureFileSchema.parse(JSON.parse(readFileSync(full, 'utf-8')));
  for (const fx of data.fixtures) {
    const userMessage = fx.match.userMessage ?? '';
    const phase = classify(userMessage);
    const schema = SCHEMAS[phase];
    if (!schema) {
      failures.push({ file, phase, issues: ['unknown phase — no schema'] });
      fail++;
      continue;
    }
    const content = fx.response.content;
    if (!content) {
      failures.push({ file, phase, issues: ['response has no content'] });
      fail++;
      continue;
    }
    let payload: unknown;
    try {
      payload = JSON.parse(content);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      failures.push({
        file,
        phase,
        issues: [`invalid JSON: ${message}`],
      });
      fail++;
      continue;
    }
    const result = schema.safeParse(payload);
    if (result.success) {
      pass++;
      console.log(`OK   ${phase.padEnd(22)} ${file}`);
    } else {
      fail++;
      const issues = result.error.issues.map(
        (i) => `${i.path.join('.')}: ${i.message}`
      );
      failures.push({ file, phase, issues });
      console.log(`FAIL ${phase.padEnd(22)} ${file}`);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed\n`);
for (const f of failures) {
  console.log(`\n--- ${f.file} (${f.phase}) ---`);
  for (const issue of f.issues.slice(0, 10)) console.log(`  ${issue}`);
  if (f.issues.length > 10) console.log(`  ... +${f.issues.length - 10} more`);
}

process.exit(fail > 0 ? 1 : 0);
