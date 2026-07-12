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

/** Join LLM picks back to full `Style` rows, preserving rank order. */
export function resolveRecommendedStyles(
  styles: Style[],
  recommendations: StyleRecommendation[] | undefined,
  limit = RECOMMENDED_STYLE_SLOT_COUNT
): Style[] {
  if (!recommendations?.length) return [];
  const byId = new Map(styles.map((s) => [s.id, s]));
  return recommendations
    .slice(0, limit)
    .map((r) => byId.get(r.styleId))
    .filter((s): s is Style => s !== undefined);
}

function bumpSelectedStyle(
  styles: Style[],
  selectedStyleId?: string | null
): Style[] {
  if (!selectedStyleId) return styles;
  const selectedIndex = styles.findIndex((s) => s.id === selectedStyleId);
  if (selectedIndex <= 0) return styles;
  const selected = styles[selectedIndex];
  if (!selected) return styles;
  return [selected, ...styles.filter((s) => s.id !== selectedStyleId)];
}

/** Catalogue order with recommendations removed (selected style bumped when needed). */
export function catalogueWithoutRecommendations(
  styles: Style[],
  recommendations: StyleRecommendation[] | undefined,
  selectedStyleId?: string | null
): Style[] {
  const recommendedIds = new Set(
    resolveRecommendedStyles(styles, recommendations).map((s) => s.id)
  );
  const rest = styles.filter((s) => !recommendedIds.has(s.id));
  return bumpSelectedStyle(rest, selectedStyleId);
}
