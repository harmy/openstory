/**
 * Split text into plain-text and mention segments by matching each item's
 * canonical `tag` plus `aliases` (longest-first, whole-word, hyphen-aware).
 * Shared by `tagifyMarkdown` (the editor) and `HighlightedPrompt` (read-only,
 * e.g. eval views) so both surfaces pill identically.
 *
 * Rules mirror `extract-continuity-from-prompt.ts`:
 *  - Cast names (`SCARLETT`) and element tokens (`BONDI_SCREEN`) are highlighted
 *    in place — they pill ONLY in their ALL-CAPS form (never lowercase prose or
 *    a stale lowercased form), with no `@`. Aliases (a legacy kebab slug) are
 *    exempt — distinctive enough to match case-insensitively.
 *  - Locations have no UPPERCASE token, so they use the kebab consistencyTag,
 *    shown as `@slug`. A leading `@` before a location tag is the mention
 *    trigger and is consumed into the pill (which re-adds its `@`).
 */

import type { MentionItem } from '@/components/scenes/prompt-mention/mention-items';

export type MentionSegment =
  | { type: 'text'; value: string }
  | { type: 'mention'; item: MentionItem; display: string };

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function splitMentions(
  text: string,
  items: MentionItem[]
): MentionSegment[] {
  if (!text) return [];
  if (items.length === 0) return [{ type: 'text', value: text }];

  // Each item contributes its canonical `tag` plus any `aliases`. Longest-first
  // so a longer slug wins over a shorter one that's a prefix of it.
  const forms: Array<{ form: string; item: MentionItem }> = [];
  for (const item of items) {
    forms.push({ form: item.tag, item });
    if (item.aliases) {
      for (const alias of item.aliases) {
        if (alias && alias !== item.tag) forms.push({ form: alias, item });
      }
    }
  }
  forms.sort((a, b) => b.form.length - a.form.length);

  const byForm = new Map<string, MentionItem>();
  for (const { form, item } of forms) byForm.set(form.toLowerCase(), item);

  const alternation = forms.map((f) => escapeForRegex(f.form)).join('|');
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_-])(${alternation})(?=[^A-Za-z0-9_-]|$)`,
    'gi'
  );

  const segments: MentionSegment[] = [];
  let lastIdx = 0;
  for (const m of text.matchAll(pattern)) {
    const prefixChar = m[1] ?? '';
    const form = m[2];
    if (form === undefined) continue;
    const item = byForm.get(form.toLowerCase());
    if (!item) continue;
    // Cast names + element tokens pill ONLY in their ALL-CAPS form (the
    // deliberate `SCARLETT` / `BONDI_SCREEN` references) — never lowercase
    // prose or a stale lowercased form. A legacy kebab alias is exempt.
    if (
      item.section !== 'locations' &&
      form.toLowerCase() === item.tag.toLowerCase() &&
      form !== form.toUpperCase()
    ) {
      continue;
    }
    const matchStart = m.index;
    const formStart = matchStart + prefixChar.length;
    const formEnd = formStart + form.length;
    // Keep the boundary char in the output — except a leading `@`, the mention
    // trigger owned by the pill's display.
    const keepPrefix = prefixChar === '@' ? '' : prefixChar;
    const before = text.slice(lastIdx, matchStart) + keepPrefix;
    if (before) segments.push({ type: 'text', value: before });
    // Cast names + element tokens highlight in place (no `@`); locations show
    // their kebab slug as `@slug`.
    const display = item.section === 'locations' ? `@${item.tag}` : item.tag;
    segments.push({ type: 'mention', item, display });
    lastIdx = formEnd;
  }
  const tail = text.slice(lastIdx);
  if (tail) segments.push({ type: 'text', value: tail });
  return segments;
}
