/**
 * Sample-video catalogue data (issue #718).
 *
 * Pure data + URL/entry builders shared by the render script
 * (`scripts/generate-style-sample-videos.ts`) and the seed
 * (`scripts/seed-style-sample-videos.ts`). Deliberately free of fal/photon/
 * ffmpeg/LLM imports so the seed and unit tests stay lightweight (the enhance +
 * scene-split LLM logic lives in `sample-script.ts`).
 *
 * Every style gets a CANONICAL sample: a per-category one-liner brief (below) is
 * run through the script-enhancer + a scene split, so each style gets a
 * style-appropriate ~15s script (same brief within a category ⇒ comparable).
 * The ~10 hero styles in BESPOKE_SCRIPTS also get a bespoke sample, from a
 * curated script tuned to show the style off.
 */
import {
  StyleSampleVideoSchema,
  type StyleSampleVideo,
} from '@/lib/db/schema/libraries';
import { styleSlug } from '@/lib/style/style-slug';

/** A single shot: a still to generate, then image-to-video to animate it. */
export type SampleBeat = {
  /** Short id used for intermediate filenames (e.g. `wide`, `pour`). */
  id: string;
  /** Subject/scene description. Style `config` is blended in at render time. */
  imagePrompt: string;
  /** Camera/motion description fed to the image-to-video model. */
  motionPrompt: string;
};

/** Nominal seconds per beat — the i2v duration we request per clip. */
export const NOMINAL_BEAT_SECONDS = 5;

/** Target length of a canonical sample (drives enhance scene count + seed metadata). */
export const CANONICAL_TARGET_SECONDS = 15;

/**
 * One-liner brief per style `category`, fed through the script-enhancer so each
 * style gets a script that suits it. Every category present in
 * `style-templates.ts` has an explicit entry (enforced by a unit test) — no
 * silent default that would render an off-brief sample.
 */
const CATEGORY_BRIEFS: Record<string, string> = {
  commercial: 'a premium 15-second brand commercial',
  ecommerce: 'a new product launch',
  influencer: 'an honest product review spoken to camera',
  animatic: 'a storyboard animatic for a new commercial',
  animation: 'a playful animated brand story',
  kids: "a fun, colorful kids' product ad",
  corporate: 'a polished company brand film',
  realestate: 'a luxury home tour',
  // Narrative film genres (action, western, sci-fi, noir, horror, rom-com,
  // award-season, documentary, Wes-Anderson) share one brief; each style's
  // config makes the enhanced script genre-appropriate.
  film: 'a cinematic short-film scene',
  photography: 'a high-end photography showcase',
  healthcare: 'a reassuring healthcare brand spot',
  food: 'a signature dish at a new restaurant',
  fitness: 'an energizing fitness brand spot',
  edtech: 'an upbeat learning-app promo',
  automotive: 'a new car reveal',
  nonprofit: 'an inspiring nonprofit story',
  travel: 'a dream getaway',
};

/** The brief used to enhance a style's canonical script. Throws on an unmapped category. */
export function briefForStyle(style: { category: string | null }): string {
  const brief = style.category ? CATEGORY_BRIEFS[style.category] : undefined;
  if (!brief) {
    throw new Error(
      `No canonical brief for category "${style.category}". Add it to CATEGORY_BRIEFS.`
    );
  }
  return brief;
}

/**
 * Bespoke hero scripts, keyed by style slug. Each is a curated ~15s, 3-beat
 * script tuned to the style. DRAFT for review — slugs must match real template
 * names in `style-templates.ts` (validated at render time).
 *
 * Hero set: one strong style per major category plus standouts.
 */
export const BESPOKE_SCRIPTS: Record<string, SampleBeat[]> = {
  'product-ad': [
    {
      id: 'shelf',
      imagePrompt:
        'A minimalist skincare bottle on a sunlit bathroom shelf beside a folded linen towel and a sprig of eucalyptus.',
      motionPrompt:
        'Slow lateral dolly across the shelf, the bottle gliding into center frame; soft morning light shifting gently.',
    },
    {
      id: 'hands',
      imagePrompt:
        'Close-up of hands pressing a pump of the product into an open palm, glossy texture catching the light.',
      motionPrompt:
        'Tight handheld shot, a single confident pump and the cream landing in the palm; fingers spreading the texture.',
    },
    {
      id: 'hero',
      imagePrompt:
        'Beauty hero frame of the bottle on a color-matched pastel background, single clean shadow.',
      motionPrompt:
        'Locked hero shot, a fine mist drifting behind the bottle as it sits perfectly still; subtle light bloom.',
    },
  ],
  'real-estate': [
    {
      id: 'approach',
      imagePrompt:
        'Exterior of a modern luxury home at golden hour, warm interior lights glowing through floor-to-ceiling glass.',
      motionPrompt:
        'Smooth forward dolly toward the entrance, low warm sun raking across the facade; steadicam-calm movement.',
    },
    {
      id: 'living',
      imagePrompt:
        'Open-plan living room with designer furniture and a city skyline beyond the windows.',
      motionPrompt:
        'Slow tracking shot gliding through the living space, warm interior light against cool exterior dusk.',
    },
    {
      id: 'reveal',
      imagePrompt:
        'Infinity-edge terrace overlooking the skyline at blue hour, water reflecting city lights.',
      motionPrompt:
        'Rising crane move revealing the terrace and skyline; serene, cinematic, architectural-digest quality.',
    },
  ],
  'glossy-product-hero': [
    {
      id: 'emerge',
      imagePrompt:
        'A sleek product emerging from deep shadow on a reflective black surface, controlled rim light.',
      motionPrompt:
        'The product rotates slowly out of darkness, a single rim light tracing its silhouette.',
    },
    {
      id: 'orbit',
      imagePrompt:
        'Three-quarter hero angle of the product on glossy black, crisp reflections beneath it.',
      motionPrompt:
        'Camera orbits the product at eye level, reflections sliding across the surface; deep blacks, clean highlights.',
    },
    {
      id: 'detail',
      imagePrompt:
        'Macro of the product logo and a precision-machined edge catching a thin specular highlight.',
      motionPrompt:
        'Slow rack focus across the engraved detail, a sharp highlight sweeping along the edge.',
    },
  ],
  'automotive-cinematic': [
    {
      id: 'switchback',
      imagePrompt:
        'A matte sports car rounding a mountain switchback at dusk, headlights sweeping the rock face.',
      motionPrompt:
        'Low tracking shot on the front quarter panel as the car carves the bend; blue-hour sky, warm headlight glow.',
    },
    {
      id: 'detail',
      imagePrompt:
        'Close detail of the wheel and brake caliper, dust and light trailing behind.',
      motionPrompt:
        'Locked low angle, the wheel spinning up as the car accelerates away, dust catching backlight.',
    },
    {
      id: 'arrival',
      imagePrompt:
        'The car parked under a single overhead light in a concrete space, reflections on wet floor.',
      motionPrompt:
        'Slow orbit around the parked car, one hard light raking the bodywork; cinematic, premium.',
    },
  ],
  'fashion-editorial': [
    {
      id: 'walk',
      imagePrompt:
        'A model in a structured linen blazer walking toward camera on a clean studio cyclorama.',
      motionPrompt:
        'Camera at waist height, slight slow motion as the fabric moves naturally; soft diffused light, no harsh shadows.',
    },
    {
      id: 'turn',
      imagePrompt:
        'The model mid-turn, fabric flaring, confident editorial pose.',
      motionPrompt:
        'Locked shot, the model turns and the garment swings; crisp, controlled studio lighting.',
    },
    {
      id: 'detail',
      imagePrompt:
        'Close-up of the blazer texture, stitching and drape in sharp relief.',
      motionPrompt:
        'Slow push-in on the fabric detail, light grazing the weave; high-fashion finish.',
    },
  ],
  'food-beverage-hero': [
    {
      id: 'plate',
      imagePrompt:
        "A chef's hands plating a dish with tweezers in a high-end kitchen, microgreens placed with care.",
      motionPrompt:
        'Tight overhead shot pulling slowly wider as the final garnish is placed; warm tungsten light, rising steam.',
    },
    {
      id: 'pour',
      imagePrompt:
        'A sauce drizzled in an arc over the plated dish, glossy and rich.',
      motionPrompt:
        'Slow-motion pour, the sauce ribboning down and pooling; appetizing specular highlights.',
    },
    {
      id: 'hero',
      imagePrompt:
        'The finished dish on a dark ceramic plate, steam rising, shallow focus.',
      motionPrompt:
        'Locked hero shot, steam curling upward, a gentle focus pull onto the centerpiece; bon-appetit production value.',
    },
  ],
  'tech-keynote': [
    {
      id: 'stage',
      imagePrompt:
        'A presenter on a dark keynote stage, a glowing product render floating on a giant screen behind.',
      motionPrompt:
        'Slow push-in from a wide stage establishing shot; clean spotlight, deep blacks, confident energy.',
    },
    {
      id: 'device',
      imagePrompt:
        'A floating 3D device render rotating above a reflective stage floor, edge lighting.',
      motionPrompt:
        'The device rotates smoothly mid-air, light sweeping its edges; sleek, futuristic.',
    },
    {
      id: 'audience',
      imagePrompt:
        'Wide of the audience silhouettes facing the glowing screen, anticipation in the room.',
      motionPrompt:
        'Slow rise over the audience toward the screen; cinematic reveal, polished and aspirational.',
    },
  ],
  'beauty-macro': [
    {
      id: 'drop',
      imagePrompt:
        'Extreme macro of a single serum droplet suspended on glass, refracting soft light.',
      motionPrompt:
        'Ultra slow-motion as the droplet trembles and settles; glistening, pristine.',
    },
    {
      id: 'texture',
      imagePrompt:
        'Macro of cream texture being drawn into a soft peak, silky and luminous.',
      motionPrompt:
        'Slow pull across the texture as a peak forms; buttery light roll-off.',
    },
    {
      id: 'skin',
      imagePrompt:
        'Macro of dewy skin with a faint glow, fine highlights along the cheek.',
      motionPrompt:
        'Gentle rack focus across the skin, a soft highlight blooming; flawless, radiant.',
    },
  ],
  'award-season': [
    {
      id: 'window',
      imagePrompt:
        'A lone figure by a rain-streaked window in a dim room, a single shaft of light across the face.',
      motionPrompt:
        'Slow push-in on the contemplative figure; moody chiaroscuro, drifting rain shadows.',
    },
    {
      id: 'turn',
      imagePrompt:
        'The figure turns toward camera, half in shadow, a flicker of emotion.',
      motionPrompt:
        'Locked close-up as the head turns into the light; restrained, prestige-drama tension.',
    },
    {
      id: 'wide',
      imagePrompt:
        'Wide of the figure alone in the cavernous, beautifully lit room.',
      motionPrompt:
        'Slow dolly back revealing the scale of the room; cinematic, awards-caliber composition.',
    },
  ],
  'travel-destination': [
    {
      id: 'aerial',
      imagePrompt:
        'Aerial over turquoise water gliding toward a white-sand beach with a boutique resort.',
      motionPrompt:
        'Smooth forward drone dolly over the water toward the shore; golden-hour light on the sand.',
    },
    {
      id: 'street',
      imagePrompt:
        'An intimate cultural moment in a sunlit old-town street, warm stone and hanging lanterns.',
      motionPrompt:
        'Handheld-smooth glide down the street past a vendor; warm, inviting, lived-in.',
    },
    {
      id: 'sunset',
      imagePrompt:
        'A couple on a terrace overlooking the sea at sunset, glasses raised.',
      motionPrompt:
        'Slow push-in toward the silhouettes against the burning sky; aspirational, cinematic.',
    },
  ],
};

/** Slugs of styles that have a bespoke sample (the ~10 hero styles). */
export function heroStyleSlugs(): string[] {
  return Object.keys(BESPOKE_SCRIPTS);
}

/** True when the given style name maps to a hero (bespoke) style. */
export function isHeroStyle(styleName: string): boolean {
  return Object.hasOwn(BESPOKE_SCRIPTS, styleSlug(styleName));
}

export type SampleVideoKind = 'canonical' | 'bespoke';

/** Public R2 URL for a style's sample video. */
export function sampleVideoUrl(
  domain: string,
  slug: string,
  kind: SampleVideoKind
): string {
  return `https://${domain}/styles/${slug}/${kind}.mp4`;
}

function beatDurationSeconds(beats: SampleBeat[]): number {
  return beats.length * NOMINAL_BEAT_SECONDS;
}

/**
 * Build the validated `sampleVideos` entries for a style. Always includes the
 * canonical sample; includes a bespoke entry when the style is a hero style.
 * Canonical is `order: 0`, bespoke `order: 1`.
 */
export function buildSampleVideos(args: {
  domain: string;
  styleName: string;
}): StyleSampleVideo[] {
  const slug = styleSlug(args.styleName);
  const entries: StyleSampleVideo[] = [
    {
      url: sampleVideoUrl(args.domain, slug, 'canonical'),
      kind: 'canonical',
      label: 'Sample',
      durationSeconds: CANONICAL_TARGET_SECONDS,
      order: 0,
    },
  ];

  const bespoke = BESPOKE_SCRIPTS[slug];
  if (bespoke) {
    entries.push({
      url: sampleVideoUrl(args.domain, slug, 'bespoke'),
      kind: 'bespoke',
      label: 'Showcase',
      durationSeconds: beatDurationSeconds(bespoke),
      order: 1,
    });
  }

  // Validate against the DB schema so a bad shape fails here, not at write time.
  return entries.map((e) => StyleSampleVideoSchema.parse(e));
}
