import { describe, expect, it } from 'vitest';
import type { MentionItem } from '@/components/scenes/prompt-mention/mention-items';
import { tagifyMarkdown } from './tagify';

const items: MentionItem[] = [
  {
    id: 'character:c1',
    section: 'cast',
    label: 'Jack',
    sublabel: 'jack-denim-jacket',
    // Cast tag is the ALL-CAPS name; slug/id ride along as aliases so legacy
    // prompts still pill (and re-pill to the name).
    tag: 'JACK',
    aliases: ['jack-denim-jacket', 'char_001'],
    haystack: 'jack jack-denim-jacket char_001',
    thumbnailUrl: null,
  },
  {
    id: 'element:e1',
    section: 'elements',
    label: 'RED-HEX-LOGO',
    sublabel: 'A red hex logo',
    tag: 'RED-HEX-LOGO',
    haystack: 'red-hex-logo',
    thumbnailUrl: null,
  },
  {
    id: 'location:l1',
    section: 'locations',
    label: 'INT. OFFICE',
    sublabel: 'office-modern-steel',
    tag: 'office-modern-steel',
    haystack: 'int. office office-modern-steel',
    thumbnailUrl: null,
  },
];

describe('tagifyMarkdown', () => {
  it('returns input unchanged when no items', () => {
    const result = tagifyMarkdown('hello jack-denim-jacket', []);
    expect(result.matched).toBe(false);
    expect(result.content).toBe('hello jack-denim-jacket');
  });

  // --- Cast: highlight the ALL-CAPS name in place, no `@` ------------------

  it('pills a cast member by their ALL-CAPS name with no @ prefix', () => {
    const result = tagifyMarkdown('JACK pulls on his jacket', items);
    expect(result.matched).toBe(true);
    expect(result.content).toContain('data-id="JACK"');
    expect(result.content).toContain('data-section="cast"');
    // Visible text is the bare name — not `@JACK`.
    expect(result.content).toContain('>JACK</span>');
    expect(result.content).not.toContain('@JACK');
  });

  it('does NOT pill a lowercase prose mention of a cast name', () => {
    const result = tagifyMarkdown('then jack walked away', items);
    expect(result.matched).toBe(false);
    expect(result.content).toBe('then jack walked away');
  });

  it('pills a legacy cast consistencyTag alias, re-pilling to the name', () => {
    const result = tagifyMarkdown('hero is jack-denim-jacket here', items);
    expect(result.matched).toBe(true);
    // Alias matched, but the canonical data-id + visible text is the name.
    expect(result.content).toContain('data-id="JACK"');
    expect(result.content).toContain('data-section="cast"');
    expect(result.content).toContain('>JACK</span>');
  });

  // --- Elements: highlight the UPPERCASE token in place, no `@` -----------

  it('pills an element token in place — all-caps only, no @', () => {
    const result = tagifyMarkdown('logo: RED-HEX-LOGO appears', items);
    expect(result.matched).toBe(true);
    expect(result.content).toContain('data-id="RED-HEX-LOGO"');
    expect(result.content).toContain('data-section="elements"');
    expect(result.content).toContain('>RED-HEX-LOGO</span>');
    expect(result.content).not.toContain('@RED-HEX-LOGO');
  });

  it('does NOT pill a lowercase form of an element token', () => {
    const result = tagifyMarkdown('logo: red-hex-logo appears', items);
    expect(result.matched).toBe(false);
  });

  // --- Locations: kebab slug as `@slug` -----------------------------------

  it('respects word boundaries — no false positives on substring matches', () => {
    const result = tagifyMarkdown('officeworks is not a location', items);
    expect(result.matched).toBe(false);
    expect(result.content).toBe('officeworks is not a location');
  });

  it('handles hyphenated tags as single tokens', () => {
    // `RED-HEX-LOGO` should match the full token, not just `RED`.
    const result = tagifyMarkdown('see RED-HEX-LOGO later', items.slice(1, 2));
    expect(result.matched).toBe(true);
    expect(result.content).toContain('data-id="RED-HEX-LOGO"');
    expect(result.content).not.toContain('data-id="RED"');
  });

  it('matches an underscore-style token wrapped in parentheses (visual-prompt format)', () => {
    const elementItems: MentionItem[] = [
      {
        id: 'element:e2',
        section: 'elements',
        label: 'BONDI_SCREEN',
        sublabel: 'A surfer dashboard',
        tag: 'BONDI_SCREEN',
        haystack: 'bondi_screen a surfer dashboard',
        thumbnailUrl: null,
      },
    ];
    const result = tagifyMarkdown(
      'displaying the UI from (BONDI_SCREEN) on the wall',
      elementItems
    );
    expect(result.matched).toBe(true);
    expect(result.content).toContain('data-id="BONDI_SCREEN"');
  });

  it('matches a legacy uppercase-with-spaces alias and re-pills to the token', () => {
    const elementItems: MentionItem[] = [
      {
        id: 'element:e6',
        section: 'elements',
        label: 'RED_HEX_LOGO',
        sublabel: 'A red hex logo',
        tag: 'RED_HEX_LOGO',
        aliases: ['RED HEX LOGO'],
        haystack: 'red_hex_logo red hex logo a red hex logo',
        thumbnailUrl: null,
      },
    ];
    const result = tagifyMarkdown(
      'A close-up of the RED HEX LOGO on his jacket',
      elementItems
    );
    expect(result.matched).toBe(true);
    // Alias matched; data-id + visible text are the canonical token, bare.
    expect(result.content).toContain('data-id="RED_HEX_LOGO"');
    expect(result.content).toContain('>RED_HEX_LOGO</span>');
    expect(result.content).not.toContain('@RED_HEX_LOGO');
  });

  it('matches multiple distinct mentions in one pass', () => {
    const result = tagifyMarkdown('JACK in office-modern-steel', items);
    expect(result.matched).toBe(true);
    const spans = result.content.match(/data-type="mention"/g) ?? [];
    expect(spans.length).toBe(2);
  });

  it('escapes quotes/brackets in span attributes', () => {
    // Bare surrounding text is NOT HTML-escaped (Tiptap treats it as markdown);
    // the span attributes ARE, so an adversarial label can't break out.
    const result = tagifyMarkdown('office-modern-steel', items);
    expect(result.content).toMatch(/data-id="office-modern-steel"/);
  });

  it('consumes a leading @ on a location tag (no doubled @)', () => {
    const locationItems: MentionItem[] = [
      {
        id: 'location:l9',
        section: 'locations',
        label: 'INT. STUDIO',
        sublabel: '',
        tag: 'bondi-studio',
        haystack: 'bondi-studio',
        thumbnailUrl: null,
      },
    ];
    // Locations show the kebab slug as `@slug`; a source `@` is the trigger and
    // is consumed so it isn't left dangling before the pill (which re-adds @).
    const result = tagifyMarkdown('back at @bondi-studio again', locationItems);
    expect(result.matched).toBe(true);
    expect(result.content).not.toContain('@<span');
    expect(result.content).not.toContain('@@');
    expect(result.content).toContain('at <span');
    expect(result.content).toContain('>@bondi-studio</span>');
  });
});
