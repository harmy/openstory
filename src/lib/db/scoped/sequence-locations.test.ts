/**
 * Tests for sequence locations helper functions
 */

import { describe, expect, it } from 'vitest';
import {
  matchLocationsToFrame,
  locationMatchesTag,
} from '@/lib/db/scoped/sequence-locations';
import type { Shot, SequenceLocation } from '@/lib/db/schema';

// Mock location data - using full SequenceLocation type
const mockLocations: [SequenceLocation, SequenceLocation, SequenceLocation] = [
  {
    id: 'loc-1',
    sequenceId: 'seq-1',
    libraryLocationId: null,
    locationId: 'loc_001',
    name: 'INT. OFFICE - DAY',
    type: 'interior',
    timeOfDay: 'day',
    description: 'A modern corporate office with glass walls',
    architecturalStyle: 'modern',
    keyFeatures: 'glass walls, open floor plan',
    colorPalette: 'neutral grays and whites',
    lightingSetup: 'natural light from large windows',
    ambiance: 'professional, corporate',
    consistencyTag: 'office_modern_glass',
    firstMentionSceneId: 'scene_001',
    firstMentionText: 'The office buzzes with activity',
    firstMentionLine: 1,
    referenceImageUrl: 'https://example.com/office.png',
    referenceImagePath: 'locations/office.png',
    referenceStatus: 'completed',
    referenceGeneratedAt: new Date(),
    referenceError: null,
    referenceInputHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'loc-2',
    sequenceId: 'seq-1',
    libraryLocationId: null,
    locationId: 'loc_002',
    name: 'EXT. STREET - NIGHT',
    type: 'exterior',
    timeOfDay: 'night',
    description: 'A busy city street at night',
    architecturalStyle: 'urban',
    keyFeatures: 'streetlights, storefronts',
    colorPalette: 'neon lights, dark shadows',
    lightingSetup: 'artificial streetlights and neon signs',
    ambiance: 'bustling, urban',
    consistencyTag: 'city_street_night',
    firstMentionSceneId: 'scene_002',
    firstMentionText: 'The city comes alive at night',
    firstMentionLine: 5,
    referenceImageUrl: 'https://example.com/street.png',
    referenceImagePath: 'locations/street.png',
    referenceStatus: 'completed',
    referenceGeneratedAt: new Date(),
    referenceError: null,
    referenceInputHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
  {
    id: 'loc-3',
    sequenceId: 'seq-1',
    libraryLocationId: null,
    locationId: 'loc_003',
    name: 'INT. APARTMENT - EVENING',
    type: 'interior',
    timeOfDay: 'evening',
    description: 'A cozy apartment',
    architecturalStyle: 'residential',
    keyFeatures: 'warm lighting, comfortable furniture',
    colorPalette: 'warm tones',
    lightingSetup: 'soft lamp lighting',
    ambiance: 'cozy, intimate',
    consistencyTag: 'apartment_cozy',
    firstMentionSceneId: 'scene_003',
    firstMentionText: 'Home sweet home',
    firstMentionLine: 10,
    referenceImageUrl: null,
    referenceImagePath: null,
    referenceStatus: 'pending',
    referenceGeneratedAt: null,
    referenceError: null,
    referenceInputHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  },
];

// Helper to create a partial mock frame with just the fields needed for matching
function createMockFrame(
  environmentTag: string,
  location: string
): Pick<Shot, 'metadata'> {
  // Create a complete Scene object with all required fields
  const metadata: NonNullable<Shot['metadata']> = {
    sceneId: 'test-scene',
    sceneNumber: 1,
    originalScript: { extract: '', dialogue: [] },
    continuity: {
      environmentTag,
      characterTags: [],
      colorPalette: '',
      lightingSetup: '',
      styleTag: '',
    },
    metadata: {
      location,
      title: '',
      durationSeconds: 0,
      timeOfDay: '',
      storyBeat: '',
    },
  };
  return { metadata };
}

describe('sequence-locations helpers', () => {
  describe('locationMatchesTag', () => {
    it('should match by consistency tag', () => {
      expect(locationMatchesTag(mockLocations[0], 'office_modern_glass')).toBe(
        true
      );
      expect(locationMatchesTag(mockLocations[0], 'OFFICE_MODERN_GLASS')).toBe(
        true
      );
      expect(locationMatchesTag(mockLocations[0], 'random_tag')).toBe(false);
    });

    it('should match by location name (partial)', () => {
      expect(locationMatchesTag(mockLocations[0], 'office')).toBe(true);
      expect(locationMatchesTag(mockLocations[1], 'street')).toBe(true);
      expect(locationMatchesTag(mockLocations[2], 'apartment')).toBe(true);
    });

    it('should match by locationId', () => {
      expect(locationMatchesTag(mockLocations[0], 'loc_001')).toBe(true);
      expect(locationMatchesTag(mockLocations[1], 'loc_002')).toBe(true);
    });

    it('should be case-insensitive', () => {
      expect(locationMatchesTag(mockLocations[0], 'OFFICE')).toBe(true);
      expect(locationMatchesTag(mockLocations[0], 'Office')).toBe(true);
    });

    it('should return false for empty tags', () => {
      expect(locationMatchesTag(mockLocations[0], '')).toBe(false);
    });
  });

  describe('matchLocationsToFrame', () => {
    it('should match locations by environment tag', () => {
      const frame = createMockFrame('office_modern_glass', 'INT. OFFICE');
      const matched = matchLocationsToFrame(frame, mockLocations);
      expect(matched).toHaveLength(1);
      const [first] = matched;
      if (!first) throw new Error('expected matched location');
      expect(first.id).toBe('loc-1');
    });

    it('should match by location metadata', () => {
      const frame = createMockFrame('', 'INT. OFFICE - DAY');
      const matched = matchLocationsToFrame(frame, mockLocations);
      expect(matched).toHaveLength(1);
      const [first] = matched;
      if (!first) throw new Error('expected matched location');
      expect(first.id).toBe('loc-1');
    });

    it('should match by street location', () => {
      const frame = createMockFrame('city_street_night', '');
      const matched = matchLocationsToFrame(frame, mockLocations);
      expect(matched).toHaveLength(1);
      const [first] = matched;
      if (!first) throw new Error('expected matched location');
      expect(first.id).toBe('loc-2');
    });

    it('should return empty array when no matches', () => {
      const frame = createMockFrame('nonexistent_location', '');
      const matched = matchLocationsToFrame(frame, mockLocations);
      expect(matched).toHaveLength(0);
    });

    it('should return empty array when no environment tag or location', () => {
      const frame = createMockFrame('', '');
      const matched = matchLocationsToFrame(frame, mockLocations);
      expect(matched).toHaveLength(0);
    });

    it('should match by partial name in location metadata', () => {
      const frame = createMockFrame('', 'street');
      const matched = matchLocationsToFrame(frame, mockLocations);
      expect(matched).toHaveLength(1);
      const [first] = matched;
      if (!first) throw new Error('expected matched location');
      expect(first.id).toBe('loc-2');
    });
  });
});
