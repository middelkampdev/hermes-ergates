/**
 * The soft fill used by Field, Card/Group and the secondary Button (docs/10
 * section 4). Those controls want a fill that reads as "soft, not the page,"
 * normally `muted`. But `muted` and a Sheet's `popover` can sit almost on top
 * of each other in a dark theme (Nous dark: `muted` #1a1e24 vs `popover`
 * #161b22), so a `muted` fill drawn on a sheet is nearly invisible. Picking
 * whichever of `muted` or `background` differs more from the surface a
 * control is actually drawn on keeps the fill visible on every surface, in
 * every theme, light or dark.
 */

import { parseRgb, type Rgb } from './color'

function distance(a: Rgb, b: Rgb): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/** Whichever of `colors.muted` or `colors.background` sits farther from `surface`. Falls back to `muted` when any of the three colors cannot be parsed. */
export function softFill(colors: { muted: string; background: string }, surface: string): string {
  const surfaceRgb = parseRgb(surface)
  const mutedRgb = parseRgb(colors.muted)
  const backgroundRgb = parseRgb(colors.background)

  if (!surfaceRgb || !mutedRgb || !backgroundRgb) {
    return colors.muted
  }

  return distance(backgroundRgb, surfaceRgb) > distance(mutedRgb, surfaceRgb) ? colors.background : colors.muted
}
