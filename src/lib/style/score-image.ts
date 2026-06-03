/**
 * Single-image quality gate for a generated still (issue #718).
 *
 * Used to QA a still BEFORE the expensive image-to-video step: generate a still,
 * score it here, and re-roll if it has a clear failure (literal-medium artifact,
 * multi-frame, or a gross anatomy error) — so we never animate a known-bad
 * frame. Unlike the comparative preview scorer this judges one image in
 * isolation; the anatomy flag is deliberately calibrated to clear/gross errors
 * only (LLM anatomy detection is unreliable — see score-style-previews.ts).
 */
import { callLLM } from '@/lib/ai/llm-client';
import type { TextModel } from '@/lib/ai/models';
import type { StyleConfig } from '@/lib/db/schema/libraries';
import type { ChatMessage } from '@/lib/prompts';
import { z } from 'zod';

export const stillVerdictSchema = z.object({
  styleAdherence: z.number().min(0).max(10),
  literalMedium: z.boolean().default(false),
  multiFrame: z.boolean().default(false),
  anatomy: z.boolean().default(false),
  unwantedText: z.boolean().default(false),
  note: z.string().default(''),
});
export type StillVerdict = z.infer<typeof stillVerdictSchema>;

const SYSTEM_PROMPT = `You are a strict art director QA-ing ONE AI-generated still that will be animated into a style sample video. Given the style's intended look and the requested scene, score the image and flag failure modes.

Return ONLY a JSON object (no markdown, no prose):
{ "styleAdherence": 0-10, "literalMedium": true|false, "multiFrame": true|false, "anatomy": true|false, "unwantedText": true|false, "note": "<=160 chars" }

- styleAdherence: how well the look matches the intended artStyle/mood/lighting/camera/colorGrading.
- literalMedium: depicts the MEDIUM/FORMAT/ARTIFACT as the object — a physical book, storyboard sheet, panel sheet, a TV/monitor/phone showing the scene — instead of a scene in the style. If the intended look IS a device/setup (phone in-hand, product on white, turntable, UI, stage), that's CORRECT → false.
- multiFrame: a grid, multiple panels, collage, split-screen, or several separate images in one frame.
- anatomy: set true ONLY for a clear, obvious anatomy error a viewer would notice at a glance — an extra / missing / duplicated / floating hand or limb, an obviously wrong finger count on a prominent hand, or a badly distorted face. Do NOT flag minor or soft imperfections, slightly messy small/background hands, or stylized hands that read as acceptable. When in doubt, set false.
- unwantedText: any text, caption, watermark, logo, or frame number.

Be strict but fair.`;

function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('Image scorer returned no JSON object');
  }
  return candidate.slice(start, end + 1);
}

/** Score one still (passed as a base64 JPEG) against its style + scene. */
export async function scoreStill(args: {
  jpegBase64: string;
  styleName: string;
  sceneDescription: string;
  config: StyleConfig;
  model: TextModel;
  apiKey: string;
}): Promise<StillVerdict> {
  const c = args.config;
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          content: [
            `STYLE: ${args.styleName}`,
            `SCENE: ${args.sceneDescription}`,
            '',
            'Intended look:',
            `- Art style: ${c.artStyle}`,
            `- Mood: ${c.mood}`,
            `- Lighting: ${c.lighting}`,
            `- Camera: ${c.cameraWork}`,
            `- Color grading: ${c.colorGrading}`,
            '',
            'Score the attached image.',
          ].join('\n'),
        },
        {
          type: 'image',
          source: {
            type: 'data',
            value: args.jpegBase64,
            mimeType: 'image/jpeg',
          },
        },
      ],
    },
  ];
  const reply = await callLLM({
    model: args.model,
    messages,
    max_tokens: 400,
    temperature: 0,
    observationName: 'score-still-gate',
    apiKey: args.apiKey,
  });
  return stillVerdictSchema.parse(JSON.parse(extractJson(reply)));
}

/** A still is unusable if it has a hard artifact flag or a gross anatomy error. */
export function stillRejected(v: StillVerdict): boolean {
  return v.literalMedium || v.multiFrame || v.anatomy;
}

export function stillFlagLabels(v: StillVerdict): string {
  return [
    v.literalMedium && 'LITERAL',
    v.multiFrame && 'MULTIFRAME',
    v.anatomy && 'ANATOMY',
    v.unwantedText && 'text',
  ]
    .filter(Boolean)
    .join(',');
}
