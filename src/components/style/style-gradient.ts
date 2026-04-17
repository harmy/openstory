/**
 * Generate a CSS gradient string from a style's color palette.
 * Used as a fallback when preview images are unavailable or fail to load.
 */
export function getStyleGradient(colorPalette: string[]): string {
  if (!colorPalette.length)
    return 'linear-gradient(135deg, hsl(var(--muted)), hsl(var(--muted-foreground) / 0.2))';
  return `conic-gradient(from 135deg, ${colorPalette.join(', ')})`;
}
