import type { StyleRecommendation } from '@/hooks/use-styles';
import type { Style } from '@/types/database';

export const RECOMMENDED_STYLE_SLOT_COUNT = 5;

/** Map recommended style ids to their one-line LLM reasoning (for tooltips). */
export function buildRecommendationReasoningMap(
  recommendations: StyleRecommendation[] | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  for (const rec of recommendations ?? []) {
    if (rec.reasoning) map.set(rec.styleId, rec.reasoning);
  }
  return map;
}

/**
 * Put the ranked recommendation shortlist first (up to `limit`), then the
 * remaining styles. When a manual selection falls outside the shortlist, bump
 * it to the front of the tail so it stays reachable in the inline grid.
 */
export function prioritizeRecommendedStyles(
  styles: Style[],
  recommendations: StyleRecommendation[] | undefined,
  limit = RECOMMENDED_STYLE_SLOT_COUNT,
  selectedStyleId?: string | null
): Style[] {
  if (!recommendations?.length) {
    if (!selectedStyleId) return styles;
    const selectedIndex = styles.findIndex((s) => s.id === selectedStyleId);
    if (selectedIndex <= 0) return styles;
    const selected = styles[selectedIndex];
    if (!selected) return styles;
    return [selected, ...styles.filter((s) => s.id !== selectedStyleId)];
  }

  const byId = new Map(styles.map((s) => [s.id, s]));
  const recommended = recommendations
    .slice(0, limit)
    .map((r) => byId.get(r.styleId))
    .filter((s): s is Style => s !== undefined);
  const recommendedIds = new Set(recommended.map((s) => s.id));
  let rest = styles.filter((s) => !recommendedIds.has(s.id));

  if (selectedStyleId && !recommendedIds.has(selectedStyleId)) {
    const idx = rest.findIndex((s) => s.id === selectedStyleId);
    if (idx > 0) {
      const selected = rest[idx];
      if (selected) {
        rest = [selected, ...rest.filter((s) => s.id !== selectedStyleId)];
      }
    }
  }

  return [...recommended, ...rest];
}
