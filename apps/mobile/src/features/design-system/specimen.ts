import { CONTRAST_PAIRS, contrastRatio, rate, type ContrastRating } from '@/theme/contrast'
import { AVATAR, ICON, LEGACY_RADIUS, LEGACY_SIZE, SPACING, TYPE, TYPE_ROLES, type MobileTheme, type TypeRole } from '@/theme/tokens'

type Colors = MobileTheme['colors']

/** Every color of the palette, sorted by key. */
export function colorSwatches(colors: Colors): { key: string; value: string }[] {
  return Object.keys(colors)
    .sort()
    .map(key => ({ key, value: colors[key as keyof Colors] ?? '' }))
}

/** One row per painted foreground/background pair; ratio and rating are null when a color is not a hex value. */
export function contrastRows(colors: Colors): {
  fg: string
  bg: string
  fgValue: string
  bgValue: string
  ratio: number | null
  rating: ContrastRating | null
}[] {
  return CONTRAST_PAIRS.map(({ fg, bg }) => {
    const fgValue = colors[fg] ?? ''
    const bgValue = colors[bg] ?? ''
    const ratio = contrastRatio(fgValue, bgValue)

    return { fg, bg, fgValue, bgValue, ratio, rating: ratio === null ? null : rate(ratio) }
  })
}

/** The type scale in table order, with a "size / weight" label. */
export function typeRows(): { role: TypeRole; fontSize: number; fontWeight: string; label: string }[] {
  return TYPE_ROLES.map(role => {
    const { fontSize, fontWeight } = TYPE[role]

    return { role, fontSize, fontWeight, label: `${fontSize} / ${fontWeight}` }
  })
}

/** Spacing steps and the named shape tokens, in declaration order. */
export function shapeRows(): {
  spacing: number[]
  radius: [string, number][]
  size: [string, number][]
  icon: [string, number][]
  avatar: [string, number][]
} {
  return {
    spacing: [...SPACING],
    radius: Object.entries(LEGACY_RADIUS),
    size: Object.entries(LEGACY_SIZE),
    icon: Object.entries(ICON),
    avatar: Object.entries(AVATAR)
  }
}
