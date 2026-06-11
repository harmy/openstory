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
 * Per-style brief overrides (keyed by style slug), consulted before
 * `CATEGORY_BRIEFS`. Primarily the nine film genres: they share
 * `category: 'film'` but need genre-specific events — the style config only
 * shapes the LOOK at image time, not what happens in the script.
 */
export const STYLE_BRIEF_OVERRIDES: Record<string, string> = {
  action:
    'a rooftop chase at night — a wiry man in his 30s in a battered jacket vaults between buildings clutching a stolen drive, a pursuit drone closing in, ending with a leap off the roof edge',
  'western-epic':
    'a horseback ride across open desert at golden hour — a woman in a dust-caked duster coat gallops through a canyon as a dust storm rises behind her, and clears a wide ravine in a single soaring leap',
  'sci-fi-futuristic':
    'an escape from a docking bay — a woman pilot in a flight suit sprints to her ship as blast doors close, slides under at the last second, and the ship tears away from the station',
  'neo-noir-thriller':
    'a rain-soaked double-cross — a briefcase handoff in an alley goes wrong, a man in a long trench coat bolts through neon-lit traffic, and the case bursts open scattering cash in the rain',
  'horror-gothic':
    'a candlelit flight through a derelict manor — a young woman in a white nightgown runs down a corridor as doors slam behind her, reaches the grand staircase, and the candle blows out',
  'rom-com':
    'a missed-train almost-kiss — a woman in a yellow coat sprints across the platform, a man in a grey suit holds the doors, and the train pulls away with both of them inside, laughing',
  'award-season':
    'a wordless reunion — a man in military uniform steps off a bus in the rain, his young daughter breaks from the crowd and runs to him, and he drops his bag to lift her up',
  pastel:
    'a symmetrical hotel caper — a young man in a crimson bellhop uniform wheels a squeaky luggage cart down a long corridor, a cat leaps aboard, and matching doors open in sequence as the cart accelerates toward the lobby',
  // Not a film genre — overrides the shared `commercial` brief because its
  // dark-warehouse + body-close-crimson default kept tripping the video
  // content checker; a brighter, full-figure motion study renders cleanly.
  'fashion-editorial':
    'a high-fashion motion study in a bright minimalist studio — a woman model in a structured emerald gown strides across the open space, the fabric lifting and rippling with each step, then turns sharply as studio strobes flare and freeze her mid-movement',
  // Styles whose shared category brief handed them the wrong content (grok
  // flagged a subject/action mismatch — e.g. a still-life style got a "sprint
  // through a warehouse"). Each is matched to the style's intent, with one
  // genuine motion beat per scene so it still honors the enhancer's motion rule.
  'luxury-still':
    'a boutique still-life launch for a single craft object — light sweeps slowly across a hand-thrown ceramic bottle on dark stone, two hands enter and turn it a quarter-rotation into the light, then set it down as a last ribbon of light crosses the rim',
  'mood-only-frames':
    'a mood-treatment lookbook in three atmospheric beats — smoke curls up through a hard shaft of light, a sheer curtain breathes inward on a draft, and a neon reflection ripples across wet night pavement',
  'alcohol-pour':
    'a slow-motion spirits pour — amber whisky streams from a tilted bottle into a crystal glass over a single clear ice sphere, the splash crowning in slow motion, condensation beading down the glass as the last drops fall',
  '360-turntable':
    'a 360 turntable product pass — a pair of premium wireless earbuds in an open charging case rotates a full slow revolution on a seamless white pedestal, light tracking across the metal hinge and matte shell as it turns to face the camera',
  'returns-friendly-diagnostic':
    'an honest product diagnostic — a hand sets a leather crossbody bag beside a ruler and a phone for scale, opens the main zip to show the lined interior, then turns it to reveal the adjustable strap and stitched seams in close detail',
  'automotive-showroom':
    'a showroom car reveal — a single silver coupe sits on a polished dealership floor as the overhead lights warm up across the hood, the camera tracks slowly down the flank catching the reflection, and a door swings open to show the cabin',
  'fintech-explainer':
    'a fintech savings explainer — a young woman checks her phone as a clean savings dashboard animates a balance ticking upward, a soft card flips to reveal a completed goal, and she exhales with a small relieved smile',
  'saas-product-demo':
    'a SaaS product demo — a cursor glides across a crisp project dashboard, a new task card snaps into a column and its status toggles to done, then the view zooms to a clean analytics chart filling in as the data lands',
  'restaurant-menu-hero':
    'a signature-dish hero — two hands lower a final garnish onto a plated dish, a ladle pours glossy sauce that pools and spreads across the plate, and steam curls up as the plate turns slowly to camera',
  // `documentary` ships a full hand-written script via
  // CANONICAL_SCRIPT_OVERRIDES (enhance: 'off'), so no brief here.
};

/**
 * The brief used to enhance a style's canonical script. Per-style override
 * first, then the category brief. Throws on an unmapped category.
 */
export function briefForStyle(style: {
  name: string;
  category: string | null;
}): string {
  const override = STYLE_BRIEF_OVERRIDES[styleSlug(style.name)];
  if (override) return override;
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
