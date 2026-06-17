/**
 * Sample-video catalogue data (issue #718).
 *
 * Pure data + URL/entry builders shared by the render script
 * (`scripts/generate-style-sample-videos.ts`) and the seed
 * (`scripts/seed-style-sample-videos.ts`). Deliberately free of heavy imports
 * so the seed and unit tests stay lightweight.
 *
 * Every style gets a CANONICAL sample: a per-category one-liner brief (below)
 * is enhanced server-side by the platform's script-enhancer, so each style
 * gets a style-appropriate ~15s script (same brief within a category ⇒
 * comparable). The ~10 hero styles in BESPOKE_SCRIPTS also get a bespoke
 * sample, from a curated script tuned to show the style off. All samples
 * render through the real OpenStory pipeline (`POST /api/v1/sequences`) so
 * recurring people/characters stay consistent across shots.
 */
import {
  StyleSampleVideoSchema,
  type StyleSampleVideo,
} from '@/lib/db/schema/libraries';
import { GENERATED_STYLE_BRIEFS } from '@/lib/style/style-briefs.generated';
import { styleSlug } from '@/lib/style/style-slug';

/** A single curated shot, flattened into script prose via `beatsToScript`. */
export type SampleBeat = {
  /** Short id naming the shot (e.g. `wide`, `pour`). */
  id: string;
  /** Subject/scene description. The style layer is applied by the pipeline. */
  imagePrompt: string;
  /** Camera/motion description for the shot. */
  motionPrompt: string;
};

/** Nominal seconds per beat/shot — used for duration targets + cost estimates. */
export const NOMINAL_BEAT_SECONDS = 5;

/** Target length of a canonical sample (drives enhance scene count + seed metadata). */
export const CANONICAL_TARGET_SECONDS = 15;

/**
 * One-liner brief per style `category`, fed through the script-enhancer so each
 * style gets a script that suits it. Every category present in
 * `style-templates.ts` has an explicit entry (enforced by a unit test) — no
 * silent default that would render an off-brief sample.
 *
 * Every brief names a concrete subject AND an event — the first render round
 * proved that a subject-less brief ("a new product launch") enhances into the
 * same inert anticipation→reveal→logo mood piece for every style, and a
 * 15-second sample where nothing happens is a boring sample. Scenes become
 * motion clips, so the brief must describe visible motion.
 *
 * Every human subject is given an explicit gender and a short visual
 * descriptor. Neutral nouns ("a courier", "a dancer") made the enhancer
 * default to singular "they", which the image model rendered as androgynous
 * figures AND gave the character-bible nothing to lock identity onto across
 * cuts — the exact consistency #801 is about. The descriptor doubles as the
 * bible's anchor, so name what the person looks like, not just what they do.
 */
export const CATEGORY_BRIEFS: Record<string, string> = {
  commercial:
    'a premium brand spot: a woman in a flowing red dress sprints through a dark warehouse, bursts through a curtain of golden dust, and lands in slow motion as light floods the space',
  ecommerce:
    'a product launch where the product assembles itself mid-air — components fly in and snap together in slow motion, and the finished product drops onto the counter with a satisfying bounce',
  influencer:
    'an honest review spoken to camera: a young man with tousled hair unboxes the product, fumbles it in surprise at how light it is, catches it one-handed, and cracks up laughing',
  animatic:
    'a storyboard animatic of a heist gone sideways — a woman in a sharp black suit grabs the case, vaults a desk, and dives through closing elevator doors',
  animation:
    'a playful animated story: a small robot chases its runaway wheel downhill through a street market, bouncing off awnings, and catches it at the lip of a fountain',
  kids: 'a kids’ ad where a juice box rockets off the table, loops around the kitchen trailing rainbow fizz, and sticks the landing in a lunchbox just as it snaps shut',
  corporate:
    'a brand film following one package across the world in three cuts — a warehouse robot lifts it, a cargo drone carries it through a storm, and a man in a courier uniform hands it over at a sunlit door',
  realestate:
    'a luxury home tour at golden hour — an elegant woman in a flowing floor-length champagne gown walks through the property: across the terrace past the still infinity pool, in through the open glass doors, and into the living room as the pendant lights bloom on one by one',
  // Narrative film genres get per-style briefs in STYLE_BRIEF_OVERRIDES (a
  // shared "cinematic scene" brief enhanced into the same figure-standing-in-
  // rain mood piece for every genre — action had no action). This entry is
  // the guarded fallback for a future film style without an override.
  film: 'a cinematic scene where something decisive happens — a chase, a confrontation, or an escape; never a person standing still',
  photography:
    'a photography showcase built on motion — a woman model with sharp features turns into a burst of strobe flashes, fabric mid-swirl, each flash freezing a different pose',
  healthcare:
    'a recovery story in three beats — an older man grips parallel bars in physical therapy, takes his first unassisted steps, then jogs the hospital corridor past applauding staff',
  food: 'the making of a signature dish — a woman chef works a flaming pan, sauce pours in slow motion, and she cuts through the finished dish as steam escapes',
  fitness:
    'one rep at the limit — a broad-shouldered man chalks up, drives the barbell overhead in slow motion as chalk dust flies, and drops it with a floor-shaking bounce',
  edtech:
    'a learning montage — a young woman sketches an equation that lifts off the page into floating diagrams around her, then snaps back into the notebook as she nails the answer',
  automotive:
    'a car reveal in motion — the car drifts through a wet hangar in a controlled slide, headlights blazing through fog, and stops dead inches from the camera',
  nonprofit:
    'a hands-in-the-dirt story — a group of volunteers plant a treeline at dawn in quick cuts, a young girl waters the first sapling, and the camera lifts to reveal a whole green field',
  travel:
    'a getaway in three jumps — a man dives off a cliff into turquoise water, a woman weaves a scooter through a market at dusk, and a paper lantern rises from the beach into the night sky',
};

/**
 * Per-style brief overrides (keyed by style slug), consulted BEFORE the
 * generated per-style briefs (`style-briefs.generated.ts`) and the category
 * fallback. The generated briefs now cover every style on-style, so this map
 * holds ONLY the three single-shot styles: their real render is the verbatim
 * `CANONICAL_SCRIPT_OVERRIDES` below; the entry here is only the review-tool
 * BRIEF label, kept matching so it doesn't show the generated multi-cut text.
 *
 * (We deliberately do NOT soften content here — e.g. the generated `action` /
 * `western-epic` briefs render verbatim so we can see what the model actually
 * does, rather than pre-empting the content checker.)
 *
 * `documentary` ships a full hand-written script via CANONICAL_SCRIPT_OVERRIDES
 * (`enhance: 'off'`), so it needs no brief here.
 */
export const STYLE_BRIEF_OVERRIDES: Record<string, string> = {
  // Creative-direction override: perfume advertising trades on allure, so the
  // generated "woman reaches into the haze" brief read too chaste. This pushes
  // the canonical render toward the sultry, sensual register the genre expects.
  'perfume-editorial':
    'A sultry high-fashion perfume film in warm, low-key light. A strikingly beautiful woman in a liquid-gold silk slip reclines against deep velvet, bare shoulders and collarbone glowing; she draws a faceted amber bottle slowly along the line of her neck, lips parted, eyes half-closed, as backlit mist drifts past — then turns a slow, smouldering look straight to camera while a sheer curtain billows behind her.',
  // Single-shot review labels — the verbatim render lives in
  // CANONICAL_SCRIPT_OVERRIDES; kept matching so the review BRIEF isn't the
  // generated multi-cut text.
  'mood-only-frames':
    'a single continuous mood frame in one charcoal-and-amber palette — incense smoke curls up through a hard diagonal shaft of light as it slowly intensifies, one unbroken locked shot, no scene change',
  '360-turntable':
    'a single continuous 360 turntable pass — one pair of premium wireless earbuds in an open charging case makes one unbroken slow revolution on a seamless white pedestal, the same case throughout, no cuts',
  'restaurant-menu-hero':
    'a single continuous signature-dish hero — one unbroken overhead shot as a ladle pours glossy amber jus across a plated sliced duck breast and a hand lowers a final micro-herb garnish, the same dish throughout, no cuts',
};

/**
 * The brief used to enhance a style's canonical script. Per-style override
 * first, then the category brief. Throws on an unmapped category.
 */
export function briefForStyle(style: {
  name: string;
  category: string | null;
}): string {
  const slug = styleSlug(style.name);
  // Hand-written overrides (film genres + the single-shot product fixes) win.
  const override = STYLE_BRIEF_OVERRIDES[slug];
  if (override) return override;
  // Then the per-style brief derived from this style's OWN description+config
  // (generate-style-briefs.ts) — replaces the too-coarse category bucket that
  // gave e.g. the "Car Talk" driving-monologue style a product-unboxing brief.
  const generated = GENERATED_STYLE_BRIEFS[slug];
  if (generated) return generated;
  // Category brief is the last-resort fallback (only hit by a new style not yet
  // in the generated set).
  const brief = style.category ? CATEGORY_BRIEFS[style.category] : undefined;
  if (!brief) {
    throw new Error(
      `No canonical brief for category "${style.category}". Add it to CATEGORY_BRIEFS.`
    );
  }
  return brief;
}

/**
 * Hand-written canonical scripts, keyed by style slug — sent verbatim
 * (`enhance: 'off'`) INSTEAD of the platform enhancing the per-category brief,
 * for styles where that brief is a poor fit. `documentary` scored ~4.3 with
 * the shared film brief (anti-narrative), so it gets an observational portrait
 * that plays to the style.
 */
export const CANONICAL_SCRIPT_OVERRIDES: Record<
  string,
  { enhancedScript: string }
> = {
  documentary: {
    // NOTE: the scene-splitter's ONE-SHOT rule needs explicit cut markers
    // ("Cut to:", sequential framings) to produce multiple frames — plain
    // continuous prose collapses to a single scene/shot.
    enhancedScript:
      'An observational documentary portrait. INT. CLUTTERED VIOLIN WORKSHOP - EARLY MORNING. ' +
      'Elena, a violin maker in her sixties — grey hair tied back, worn canvas apron over a dark linen shirt — works alone at a bench by the window. ' +
      'Handheld close shot: her hands plane the spruce top of an unfinished violin, pale wood shavings curling away from the blade, dust drifting in the window light.\n\n' +
      'Cut to: a handheld medium close-up. Elena lifts the unvarnished violin body to the window light and turns it slowly, checking the curve of the arching with her thumb.\n\n' +
      'Cut to: a wide shot. Elena sits back on her stool, the violin resting on her knee, and looks at it in silence — the workshop quiet around her, morning light across the bench.',
  },
  // Single-hero-object styles. With NO recurring person to anchor, the
  // character-bible can't keep the product consistent, so multi-scene versions
  // morphed the hero object across cuts (earbuds→briefcase, duck→a different
  // duck, smoke→an unrelated street). Written as continuous prose with NO cut
  // markers so the splitter keeps them to ONE scene → one image → nothing to
  // morph between. (Brief copies live in STYLE_BRIEF_OVERRIDES for the review
  // label only; these scripts are what render, verbatim.)
  '360-turntable': {
    enhancedScript:
      'A premium product turntable shot. A single pair of matte-black wireless earbuds nestled in their open charging case, centered on a seamless white pedestal under soft, even three-point studio light, the brushed-metal hinge catching one clean specular highlight. ' +
      'In one continuous, unbroken locked-camera shot the turntable rotates the case through a single slow full revolution — the very same case throughout, its matte shell and the two earbuds never changing shape or finish — the traveling highlight sweeping across the hinge and lid as each face turns to camera and the case settles back exactly where it began. No cuts, no scene change, one steady rotation.',
  },
  'restaurant-menu-hero': {
    enhancedScript:
      'A signature-dish restaurant hero shot. A sliced duck breast fanned in five even pieces over a single swipe of glossy amber jus on a matte charcoal ceramic plate, lit by warm directional restaurant light, shallow depth of field. ' +
      'In one continuous, unbroken overhead shot a ladle pours a thin ribbon of that same amber jus, which pools and spreads slowly across the plate, fine steam curling upward, as a single hand lowers one last micro-herb garnish onto the duck and the plate turns a few degrees to camera — the same dish the whole time, the duck slices, the amber sauce colour and the garnish never changing. No cuts, no second dish, one held shot.',
  },
  'mood-only-frames': {
    enhancedScript:
      'A single atmospheric mood frame in a charcoal-and-amber palette. A dark, near-empty room with one hard diagonal shaft of warm light falling across suspended dust; a slow ribbon of incense smoke rises into the beam. ' +
      'In one continuous, unbroken locked shot the smoke twists and blooms upward as the light gradually intensifies and a sheer curtain at the edge of frame breathes inward on a faint draft — the same room and the same palette throughout, pure evolving mood. No cuts, no scene change, no figures.',
  },
};

/**
 * Flatten curated beats into prose the real pipeline can scene-split — the
 * API takes a script rather than per-shot prompts, so its scene split decides
 * the final shots.
 */
export function beatsToScript(beats: SampleBeat[]): string {
  return beats
    .map((beat, i) => `Shot ${i + 1}: ${beat.imagePrompt} ${beat.motionPrompt}`)
    .join('\n\n');
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
