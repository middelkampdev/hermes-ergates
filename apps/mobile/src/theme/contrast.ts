import { parseRgb } from './color'
import type { MobileTheme } from './tokens'

export type ContrastRating = 'AAA' | 'AA' | 'AA large' | 'Fail'
export type ColorKey = keyof MobileTheme['colors']

/** Foreground/background pairs the app actually paints. */
export const CONTRAST_PAIRS: readonly { fg: ColorKey; bg: ColorKey }[] = [
  { fg: 'foreground', bg: 'background' },
  { fg: 'mutedForeground', bg: 'background' },
  { fg: 'mutedForeground', bg: 'muted' },
  { fg: 'primaryForeground', bg: 'primary' },
  { fg: 'destructiveForeground', bg: 'destructive' },
  { fg: 'foreground', bg: 'userBubble' },
  { fg: 'foreground', bg: 'muted' },
  { fg: 'foreground', bg: 'popover' }
]

function linear(channel: number): number {
  const c = channel / 255

  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function luminance(hex: string): number | null {
  const rgb = parseRgb(hex)

  if (!rgb) {
    return null
  }

  return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2])
}

/**
 * WCAG 2.x contrast ratio, lighter over darker. Null when either color is not a hex value.
 * An alpha byte is ignored: colors are treated as opaque.
 */
export function contrastRatio(a: string, b: string): number | null {
  const la = luminance(a)
  const lb = luminance(b)

  if (la === null || lb === null) {
    return null
  }

  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

export function rate(ratio: number): ContrastRating {
  if (ratio >= 7) {
    return 'AAA'
  }

  if (ratio >= 4.5) {
    return 'AA'
  }

  return ratio >= 3 ? 'AA large' : 'Fail'
}
