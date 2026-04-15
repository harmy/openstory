import { getEnv } from '#env';
import type { Style } from '@/types/database';

/**
 * Get the R2 public assets domain from environment
 */
function getPublicAssetsDomain(): string {
  return getEnv().VITE_R2_PUBLIC_ASSETS_DOMAIN;
}

/**
 * Generate preview URL for a style
 */
function getStylePreviewUrl(styleName: string): string {
  const sanitized = styleName
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');

  return `https://${getPublicAssetsDomain()}/styles/${sanitized}/thumbnail.webp`;
}

// Default style templates that can be imported into any team
export const DEFAULT_STYLE_TEMPLATES: Array<
  Omit<Style, 'id' | 'teamId' | 'createdAt' | 'updatedAt' | 'createdBy'>
> = [
  {
    name: 'Product Ad',
    description:
      'Fresh, tactile product content with lifestyle context and sensory detail. Designed for Instagram, DTC brands, e-commerce, and social-first campaigns.',
    category: 'ecommerce',
    tags: ['ecommerce', 'product', 'instagram', 'dtc', 'lifestyle', 'social'],
    config: {
      mood: 'Fresh, sensory, and effortlessly cool',
      artStyle:
        'Modern social-first product photography with tactile, editorial energy. Products shown in real-life context -- hands opening packaging, fingers pressing textures, products on bathroom shelves, kitchen counters, rumpled linen. Close-up detail shots emphasize material and finish. Flat-lays with curated minimal arrangements. Color-matched backgrounds that complement the product. Every frame feels like something you would screenshot and save',
      lighting:
        'Bright natural window light with clean directional shadows. Direct on-camera flash for punchy editorial energy on select shots. No heavy diffusion -- let light feel real and immediate. Golden hour warmth for lifestyle moments. High-key and airy overall with pops of contrast',
      colorPalette: ['#FFFFFF', '#F0E6D3', '#D4536D', '#1A1A1A', '#E8F4E8'],
      cameraWork:
        'Dynamic mix of handheld and locked shots with consistent energy. Handheld with natural micro-movement for lifestyle moments -- hands interacting, daily rituals, real context. Quick-cut to locked beauty frames for hero product shots. Macro details on textures and surfaces. Overhead flat-lays directly above. Eye-level and slightly above angles. Shallow depth of field on tactile details. Energetic pacing -- no lingering, every frame earns its time',
      referenceFilms: [
        'Rhode Skin Instagram',
        'Glossier Visual Identity',
        'Summer Fridays Campaigns',
        'Drunk Elephant Content',
      ],
      colorGrading:
        'Clean and bright with true-to-life color. Whites are crisp, skin tones warm and natural. Minimal processing -- the product looks like it does in your hand. Slight warmth in highlights, lifted shadows keeping everything airy. One accent color pops against neutral base',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('Product Ad'),
    sortOrder: 1,
    version: null,
    usageCount: null,
  },
  {
    name: 'Real Estate',
    description:
      'Prestige property cinematography with golden-hour warmth and aspirational lifestyle framing. Glamorous figures inhabit sun-drenched interiors, adding warmth and scale to luxury spaces. Designed for high-end real estate branding, lifestyle property films, and luxury development showcases.',
    category: 'realestate',
    tags: [
      'real-estate',
      'property',
      'luxury',
      'lifestyle',
      'prestige',
      'interior-design',
    ],
    config: {
      mood: 'Luxurious, aspirational, and effortlessly glamorous',
      artStyle:
        'Prestige property cinematography with editorial lifestyle sensibility. Luxury interiors shot with depth and grandeur -- marble surfaces, floor-to-ceiling windows, curated furnishings. Elegant women in designer loungewear or evening attire occupy the spaces naturally -- reading on a linen sofa, pouring wine at a kitchen island, silhouetted against a sunset terrace. The architecture dominates every frame while human presence adds warmth, scale, and aspiration. Compositions emphasize clean sight lines, spatial depth, and the interplay of golden light with rich materials',
      lighting:
        'Late afternoon golden hour streaming through expansive windows, casting long warm beams across polished floors and textured surfaces. Rim light catching hair and shoulders of figures in the space. Balanced ambient fill preserving detail in corners and alcoves. Interior spaces glow with warm artificial accents -- table lamps, pendant fixtures -- blending seamlessly with fading daylight',
      colorPalette: ['#F5EDE3', '#C9A96E', '#6B4C3B', '#E8D5C4', '#2C2420'],
      cameraWork:
        'Slow, cinematic dolly movements through grand interiors at eye level. Smooth reveals through doorways framing figures in the distance. Wide establishing shots of exteriors at golden hour, intimate medium shots of lifestyle moments. Shallow depth of field isolating textures and details -- a hand on a marble countertop, light catching crystal glassware. Symmetrical compositions for architectural grandeur, rule-of-thirds for lifestyle vignettes',
      referenceFilms: [
        "Sotheby's International Realty Brand Films",
        'Tom Ford A Single Man Interiors',
        'Succession HBO Cinematography',
        'The Great Gatsby Production Design',
      ],
      colorGrading:
        'Warm and luminous with rich golden highlights and creamy skin tones. Lifted shadows keeping interiors airy and inviting. Subtle amber shift throughout, with deep walnut tones in shadows. Skin rendered with warmth and softness. Overall palette feels like late-afternoon sun on travertine',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('Real Estate'),
    sortOrder: 2,
    version: null,
    usageCount: null,
  },
  {
    name: 'YouTube',
    description:
      'High-energy, visually diverse content with fast-paced editing rhythm and cinematic B-roll. Built for video essays, tutorials, product reviews, vlogs, and creator-led explainers -- every frame a different shot from a well-cut sequence.',
    category: 'youtube',
    tags: [
      'youtube',
      'creator',
      'vlog',
      'tutorial',
      'review',
      'video-essay',
      'explainer',
      'b-roll',
    ],
    config: {
      mood: 'Confident, high-energy, and visually varied -- shifting between focused intimacy in close-ups and expansive cinematic scope in B-roll. Every frame earns attention through visual interest, not repetition',
      artStyle:
        'Modern YouTube production aesthetic built on shot variety. Alternate between: direct-to-camera medium shots with shallow depth of field for presenting, tight macro inserts of hands interacting with products and objects, cinematic establishing B-roll of environments and locations, over-the-shoulder and POV angles for demonstrations. Backgrounds shift between styled studio spaces, outdoor locations, coffee shops, streets, and workspaces. Real-world texture and tactile interaction in every frame -- hands typing, unboxing, touching surfaces. Every shot feels like a different cut from a well-edited video',
      lighting:
        'Adapts to shot context. Studio frames: bright key light with subtle colored rim accent for depth separation, face well-lit and clear. Location B-roll: natural light -- golden hour warmth, overcast soft diffusion, or dramatic side-light for texture. Insert shots: focused directional light isolating the subject against soft bokeh. Practical lights used atmospherically -- screen glow, desk lamps, cafe ambient. Overall: high clarity on subject, cinematic atmosphere in environment',
      colorPalette: ['#FF4D4D', '#1E1E2E', '#00D4FF', '#FFFFFF', '#FFB800'],
      cameraWork:
        'Dynamic editing rhythm -- every frame is a different shot type from a fast-paced cut sequence. Locked shallow-DOF medium for presenting to camera. Smooth gimbal tracking for walk-and-talk reveals. Locked macro close-ups of hands, products, and textures at 45-degree or overhead angles. Slow push-in on key moments for emphasis. Handheld with natural micro-movement for outdoor vlog energy. Wide establishing shots of locations and environments. No two consecutive frames share the same angle or distance',
      referenceFilms: [
        'MKBHD Product Review Cinematography',
        'Johnny Harris Video Essay Visual Style',
        'Casey Neistat Vlog Energy',
        'Peter McKinnon B-Roll Aesthetic',
      ],
      colorGrading:
        'Punchy and clean with high contrast. Rich skin tones kept warm and natural. Teal-orange split in shadows and highlights for modern digital look. Outdoor shots lean warmer, studio shots cooler. Deep blacks, crisp whites. Vivid but not oversaturated -- polished without feeling clinical',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('YouTube'),
    sortOrder: 3,
    version: null,
    usageCount: null,
  },
  {
    name: 'Corporate',
    description:
      'Clean, professional visuals with contemporary design sensibility. Ideal for company culture videos, SaaS product demos, training content, and corporate communications.',
    category: 'corporate',
    tags: ['corporate', 'saas', 'business', 'professional', 'training', 'tech'],
    config: {
      mood: 'Professional, innovative, and trustworthy',
      artStyle:
        'Contemporary corporate visual style with clean geometry and professional environments. Modern office spaces, collaborative workspaces, and technology-forward settings. People appear natural and engaged, not staged. Compositions are balanced and uncluttered with intentional use of negative space',
      lighting:
        'Bright, even overhead lighting typical of modern offices with large windows. Soft and clean with no dramatic shadows. Natural daylight supplemented by warm artificial ambiance. Flattering and professional without being clinical',
      colorPalette: ['#0066FF', '#F8F9FA', '#1A1A2E', '#00C853', '#6C757D'],
      cameraWork:
        'Smooth dolly or gimbal movements through workspace environments. Static or slow-push medium shots for interviews and presentations. Over-the-shoulder angles for screen and product demonstrations. Clean, corporate B-roll pacing',
      referenceFilms: [
        'Stripe Brand Films',
        'Notion Product Videos',
        'HubSpot Culture Videos',
        'Salesforce Dreamforce Keynotes',
      ],
      colorGrading:
        'Clean and modern with slight cool cast. Whites are bright and true, skin tones natural. Subtle blue tint in shadows for a tech-forward feel. Overall bright and airy with controlled, professional color rendering',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('Corporate'),
    sortOrder: 4,
    version: null,
    usageCount: null,
  },
  {
    name: 'Award Season',
    description:
      'Deep, emotional storytelling with rich cinematography. Perfect for character-driven narratives.',
    category: 'cinematic',
    tags: ['drama', 'emotional', 'character-driven', 'cinematic'],
    config: {
      artStyle: 'Cinematic drama with deep shadows and warm tones',
      colorPalette: ['#8B4513', '#D2691E', '#F4A460', '#2F4F4F', '#708090'],
      lighting: 'Dramatic chiaroscuro lighting with strong contrast',
      cameraWork: 'Slow, deliberate movements with meaningful close-ups',
      mood: 'Introspective and emotional',
      referenceFilms: ['The Godfather', 'There Will Be Blood', 'Moonlight'],
      colorGrading: 'Warm highlights with cool shadows',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('Award Season'),
    sortOrder: 5,
    version: null,
    usageCount: null,
  },
  {
    name: 'Documentary',
    description:
      'Natural, observational style with authentic lighting and handheld movement.',
    category: 'documentary',
    tags: ['documentary', 'realistic', 'natural', 'authentic', 'observational'],
    config: {
      artStyle: 'Natural documentary style with authentic environments',
      colorPalette: ['#8B7355', '#CD853F', '#DEB887', '#F5DEB3', '#FFE4B5'],
      lighting: 'Natural and available light only',
      cameraWork: 'Handheld camera with observational framing',
      mood: 'Authentic and immediate',
      referenceFilms: ['Free Solo', 'The Act of Killing', 'Citizenfour'],
      colorGrading: 'Natural color with slight desaturation',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('Documentary'),
    sortOrder: 6,
    version: null,
    usageCount: null,
  },
  {
    name: 'Action',
    description:
      'High-energy visuals with dynamic camera work and explosive color palette.',
    category: 'action',
    tags: ['action', 'blockbuster', 'explosive', 'dynamic', 'adventure'],
    config: {
      artStyle: 'High-octane action with dynamic compositions',
      colorPalette: ['#FF4500', '#FFD700', '#1E90FF', '#FF6347', '#FFA500'],
      lighting: 'High contrast with dramatic rim lighting',
      cameraWork: 'Fast cuts, sweeping crane shots, and dynamic angles',
      mood: 'Exciting and adrenaline-pumping',
      referenceFilms: ['Mad Max: Fury Road', 'John Wick', 'Mission Impossible'],
      colorGrading: 'Saturated colors with orange and teal contrast',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('Action'),
    sortOrder: 7,
    version: null,
    usageCount: null,
  },
  {
    name: 'Rom-Com',
    description:
      'Bright, warm visuals with soft lighting and cheerful compositions.',
    category: 'romance',
    tags: ['romance', 'comedy', 'lighthearted', 'warm', 'feelgood'],
    config: {
      artStyle: 'Warm and inviting with soft, romantic lighting',
      colorPalette: ['#FFC0CB', '#FFDAB9', '#FFE4E1', '#F0FFFF', '#FFFACD'],
      lighting: 'Soft, diffused lighting with warm tones',
      cameraWork: 'Smooth movements with intimate framing',
      mood: 'Light, romantic, and optimistic',
      referenceFilms: ['La La Land', 'Amelie', 'When Harry Met Sally'],
      colorGrading: 'Warm and saturated with soft contrast',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('Rom-Com'),
    sortOrder: 8,
    version: null,
    usageCount: null,
  },
  {
    name: 'Animated',
    description:
      'Premium, adult-oriented animation with rich textures, painterly detail, and cinematic depth. Built for sophisticated storytelling, dark fantasy, sci-fi, and narrative-driven content.',
    category: 'animation',
    tags: [
      'animation',
      'sophisticated',
      'cinematic',
      'dark',
      'premium',
      'narrative',
    ],
    config: {
      artStyle:
        'High-fidelity stylized animation with painterly textures and hand-crafted detail. Environments are richly layered with depth and atmosphere -- decayed grandeur, neon-lit cityscapes, or lush otherworldly landscapes. Characters have grounded proportions with expressive, nuanced faces. Every frame composed like a standalone illustration',
      colorPalette: ['#1B1F3B', '#C9A227', '#8B2252', '#2E4045', '#D4A574'],
      lighting:
        'Dramatic volumetric lighting with god rays, atmospheric haze, and deep contrast. Motivated sources -- firelight, neon signage, bioluminescence -- casting colored shadows. Rim lighting separates characters from richly detailed backgrounds. Chiaroscuro for emotional weight',
      cameraWork:
        'Cinematic camera language -- slow tracking shots through detailed environments, dramatic rack focuses between foreground and background layers. Low angles for power, high angles for vulnerability. Long takes that let the world breathe, punctuated by sharp editorial cuts for impact',
      mood: 'Intense, layered, and emotionally complex',
      referenceFilms: [
        'Arcane',
        'Love Death + Robots',
        'Into the Spider-Verse',
        'Wolfwalkers',
      ],
      colorGrading:
        'Deep, moody palette with crushed blacks and selective saturation. Warm amber and gold for intimate scenes, cold steel blue for tension. Rich jewel tones used sparingly as accent. Overall filmic with subtle grain and texture overlay',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('Animated'),
    sortOrder: 9,
    version: null,
    usageCount: null,
  },
  {
    name: 'Neo-Noir Thriller',
    description:
      'Dark, stylized visuals with high contrast and urban settings. Ideal for mystery and crime stories.',
    category: 'noir',
    tags: ['noir', 'thriller', 'urban', 'mystery', 'crime'],
    config: {
      artStyle: 'Neo-noir with stark contrasts and neon accents',
      colorPalette: ['#000000', '#FF0000', '#00CED1', '#4B0082', '#FF1493'],
      lighting: 'High contrast with venetian blind shadows and neon highlights',
      cameraWork: 'Dutch angles and voyeuristic framing',
      mood: 'Tense and mysterious',
      referenceFilms: ['Blade Runner', 'Sin City', 'Drive'],
      colorGrading: 'Desaturated with selective color pops',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('Neo-Noir Thriller'),
    sortOrder: 10,
    version: null,
    usageCount: null,
  },
  {
    name: 'Pastel',
    description:
      'Obsessively symmetrical live-action cinematography with candy-colored pastels, dollhouse interiors, and deadpan whimsy.',
    category: 'artistic',
    tags: ['whimsical', 'symmetrical', 'pastel', 'quirky', 'artistic'],
    config: {
      artStyle:
        'Obsessively symmetrical, centered, planimetric frontal framing. Meticulously art-directed interiors with period props, patterned wallpaper, corduroy upholstery, brass fixtures, and leather luggage arranged in dollhouse-like environments. Live-action photographic cinematography — NOT cartoon, NOT illustration, NOT animation. Real actors in real sets. Candy-colored pastels dominate every surface: dusty pinks, powder blues, butter yellows, lavender, mint green. Vintage textures and handcrafted details in every frame',
      colorPalette: ['#FFB6C1', '#87CEEB', '#F0E68C', '#DDA0DD', '#98FB98'],
      lighting:
        'Soft, perfectly even diffused lighting with minimal shadows. Warm tones reminiscent of 1960s-70s Kodak film stock. Flat illumination that emphasizes set design over dramatic shadow',
      cameraWork:
        'Centered framing, tracking shots, and planimetric composition',
      mood: 'Whimsical melancholy, deadpan charm, nostalgic precision',
      referenceFilms: [
        'Grand Budapest Hotel',
        'Moonrise Kingdom',
        'The Royal Tenenbaums',
      ],
      colorGrading:
        'Muted saturated pastels with warm vintage film emulsion. Lifted blacks, soft film grain, slightly faded highlights. Every color feels hand-picked and coordinated',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('Pastel'),
    sortOrder: 11,
    version: null,
    usageCount: null,
  },
  {
    name: 'Sci-Fi Futuristic',
    description:
      'Clean, high-tech aesthetics with cool tones and sleek designs.',
    category: 'scifi',
    tags: ['scifi', 'futuristic', 'technology', 'space', 'cyberpunk'],
    config: {
      artStyle: 'Futuristic sci-fi with clean lines and holographic elements',
      colorPalette: ['#00FFFF', '#0000FF', '#C0C0C0', '#800080', '#00FF00'],
      lighting: 'Cool LED lighting with lens flares',
      cameraWork: 'Smooth camera movements with wide establishing shots',
      mood: 'Futuristic and technological',
      referenceFilms: ['Ex Machina', 'Arrival', 'Interstellar'],
      colorGrading: 'Cool blues and teals with high contrast',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('Sci-Fi Futuristic'),
    sortOrder: 12,
    version: null,
    usageCount: null,
  },
  {
    name: 'Horror Gothic',
    description:
      'Dark, atmospheric visuals with Gothic elements and unsettling compositions.',
    category: 'horror',
    tags: ['horror', 'gothic', 'dark', 'atmospheric', 'supernatural'],
    config: {
      artStyle: 'Gothic horror with dark shadows and eerie atmosphere',
      colorPalette: ['#1C1C1C', '#8B0000', '#483D8B', '#2F4F4F', '#696969'],
      lighting: 'Low-key lighting with harsh shadows',
      cameraWork: 'Unsettling angles and slow zooms',
      mood: 'Ominous and foreboding',
      referenceFilms: ['The Witch', 'Hereditary', 'The Lighthouse'],
      colorGrading: 'Desaturated with crushed blacks',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('Horror Gothic'),
    sortOrder: 13,
    version: null,
    usageCount: null,
  },
  {
    name: 'Western Epic',
    description:
      'Wide vistas with dusty, golden hour lighting and classic Western aesthetics.',
    category: 'western',
    tags: ['western', 'epic', 'frontier', 'classic', 'americana'],
    config: {
      artStyle: 'Classic Western with wide landscapes and golden hour lighting',
      colorPalette: ['#D2691E', '#8B4513', '#DEB887', '#CD853F', '#F4A460'],
      lighting: 'Magic hour lighting with long shadows',
      cameraWork: 'Wide shots, slow zooms, and classic Western framing',
      mood: 'Epic and frontier-inspired',
      referenceFilms: [
        'The Good, The Bad and The Ugly',
        'Once Upon a Time in the West',
        'The Searchers',
      ],
      colorGrading: 'Warm, dusty tones with high contrast',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('Western Epic'),
    sortOrder: 14,
    version: null,
    usageCount: null,
  },
  {
    name: 'Lo-Fi Retro',
    description:
      'Simulates the look of circa-2016 smartphone photography. Characterized by lower resolution, poor dynamic range, digital noise, and crunchy JPEG processing.',
    category: 'photography',
    tags: ['lo-fi', 'retro', 'amateur', '2010s', 'no-text', 'digital-noise'],
    config: {
      artStyle:
        'Retro smartphone JPEG aesthetic. Clean image with absolutely NO text overlays, NO datestamps, and NO time indicators burnt into the visual. Visible digital compression artifacts and over-sharpening. Textures are slightly soft/muddy. Includes sensor limitations: significant digital noise in shadows and color fringing.',
      colorPalette: ['#F5F5DC', '#D2B48C', '#8B4513', '#FFFAF0', '#2F4F4F'],
      lighting:
        'Low dynamic range (LDR). Highlights are blown out/clipped (loss of detail in bright areas like skies or lamps). Shadows are crushed and grainy. Simulates the struggle of older sensors to balance exposure.',
      cameraWork:
        'Handheld amateur perspective, f/1.8 aperture. Less sophisticated stabilization implies slight micro-jitters. Focus is decent but not clinical; background separation is digital and less smooth than modern sensors.',
      mood: 'Nostalgic, amateur, authentic snapshot quality with no professional polish. Pure photographic capture.',
      referenceFilms: [
        'Amateur Vlogs circa 2016',
        'Early Instagram Aesthetic',
        'Raw Phone Camera Roll',
      ],
      colorGrading:
        'Standard Rec.709 sRGB with older auto-white balance tendencies (often slightly too cool or too warm). No Log profile. Colors appear "baked in" and digital.',
    },
    isPublic: true,
    isTemplate: true,
    previewUrl: getStylePreviewUrl('Lo-Fi Retro'),
    sortOrder: 15,
    version: null,
    usageCount: null,
  },
];

// System styles without teamId - teamId will be added during seeding
export const DEFAULT_SYSTEM_STYLES: Omit<Style, 'id' | 'teamId'>[] =
  DEFAULT_STYLE_TEMPLATES.map((style) => ({
    ...style,
    createdAt: new Date(),
    updatedAt: new Date(),
    createdBy: 'system',
  }));

// Mock styles for testing - includes mock IDs and teamId
export const MOCK_SYSTEM_STYLES: Style[] = DEFAULT_SYSTEM_STYLES.map(
  (style) => ({
    ...style,
    id: style.name.replace(/\s+/g, '-').toLowerCase(),
    teamId: 'mock-system-team-id', // Mock team ID for testing
  })
);
