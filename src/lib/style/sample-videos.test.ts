import { StyleSampleVideoSchema } from '@/lib/db/schema/libraries';
import { DEFAULT_STYLE_TEMPLATES } from '@/lib/style/style-templates';
import { describe, expect, it } from 'vitest';
import {
  BESPOKE_SCRIPTS,
  briefForStyle,
  buildSampleVideos,
  CANONICAL_TARGET_SECONDS,
  heroStyleSlugs,
  isHeroStyle,
  sampleVideoUrl,
} from './sample-videos';
import { styleSlug } from './style-slug';

const DOMAIN = 'assets.openstory.so';

describe('sampleVideoUrl', () => {
  it('builds canonical and bespoke R2 URLs', () => {
    expect(sampleVideoUrl(DOMAIN, 'product-ad', 'canonical')).toBe(
      'https://assets.openstory.so/styles/product-ad/canonical.mp4'
    );
    expect(sampleVideoUrl(DOMAIN, 'product-ad', 'bespoke')).toBe(
      'https://assets.openstory.so/styles/product-ad/bespoke.mp4'
    );
  });
});

describe('buildSampleVideos', () => {
  it('returns only a canonical entry for a non-hero style', () => {
    const entries = buildSampleVideos({
      domain: DOMAIN,
      styleName: 'White Background Studio',
    });
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: 'canonical', order: 0 });
  });

  it('returns canonical + bespoke for a hero style', () => {
    const entries = buildSampleVideos({
      domain: DOMAIN,
      styleName: 'Product Ad',
    });
    expect(entries.map((e) => e.kind)).toEqual(['canonical', 'bespoke']);
    expect(entries.map((e) => e.order)).toEqual([0, 1]);
  });

  it('stamps the canonical target duration', () => {
    const [canonical] = buildSampleVideos({
      domain: DOMAIN,
      styleName: 'White Background Studio',
    });
    expect(canonical?.durationSeconds).toBe(CANONICAL_TARGET_SECONDS);
  });

  it('produces entries that satisfy the DB schema', () => {
    for (const style of DEFAULT_STYLE_TEMPLATES) {
      const entries = buildSampleVideos({
        domain: DOMAIN,
        styleName: style.name,
      });
      for (const entry of entries) {
        expect(() => StyleSampleVideoSchema.parse(entry)).not.toThrow();
      }
    }
  });
});

describe('hero styles', () => {
  it('every bespoke slug maps to a real template name', () => {
    const templateSlugs = new Set(
      DEFAULT_STYLE_TEMPLATES.map((s) => styleSlug(s.name))
    );
    for (const slug of heroStyleSlugs()) {
      expect(templateSlugs.has(slug)).toBe(true);
    }
  });

  it('every bespoke script has at least one beat', () => {
    for (const [slug, beats] of Object.entries(BESPOKE_SCRIPTS)) {
      expect(beats.length, slug).toBeGreaterThan(0);
    }
  });

  it('isHeroStyle matches the bespoke map', () => {
    expect(isHeroStyle('Product Ad')).toBe(true);
    expect(isHeroStyle('White Background Studio')).toBe(false);
  });
});

describe('briefForStyle', () => {
  it('resolves a non-empty brief for every template category (no silent default)', () => {
    for (const style of DEFAULT_STYLE_TEMPLATES) {
      const brief = briefForStyle(style);
      expect(brief, style.name).toBeTruthy();
    }
  });

  it('throws on an unmapped category', () => {
    expect(() => briefForStyle({ category: 'not-a-real-category' })).toThrow();
  });
});
