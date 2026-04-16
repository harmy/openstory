import type { LibraryLocation } from '@/lib/db/schema';

// Default location templates available to all teams
export const DEFAULT_LOCATION_TEMPLATES: Array<
  Omit<
    LibraryLocation,
    'id' | 'teamId' | 'createdAt' | 'updatedAt' | 'createdBy'
  >
> = [
  {
    name: 'Rooftop Bar at Golden Hour',
    description:
      'Sleek outdoor lounge with panoramic city skyline views, warm string lights, lush greenery planters, and a glowing amber sky. Low modern seating, craft cocktails on marble tables. Aspirational and cinematic.',
    referenceImageUrl: null,
    referenceImagePath: null,
    isPublic: true,
    isTemplate: true,
  },
  {
    name: 'Neon-Lit Tokyo Alley',
    description:
      'Narrow rain-slicked backstreet with stacked glowing signs in Japanese, steam rising from street food stalls, vending machine glow, and reflective puddles. Moody, electric, and endlessly atmospheric.',
    referenceImageUrl: null,
    referenceImagePath: null,
    isPublic: true,
    isTemplate: true,
  },
  {
    name: 'Sunlit Loft Studio',
    description:
      'Airy industrial loft with exposed brick, massive arched windows flooding warm natural light, a velvet couch, scattered art supplies, and hanging plants. Creative, intimate, and effortlessly photogenic.',
    referenceImageUrl: null,
    referenceImagePath: null,
    isPublic: true,
    isTemplate: true,
  },
];

// System locations with timestamps for seeding
export const DEFAULT_SYSTEM_LOCATIONS: Array<
  Omit<LibraryLocation, 'id' | 'teamId' | 'createdBy'>
> = DEFAULT_LOCATION_TEMPLATES.map((l) => ({
  ...l,
  createdAt: new Date(),
  updatedAt: new Date(),
}));
