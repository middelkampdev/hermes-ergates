/**
 * Mobile theme object consumed by components (docs/10 sections 2–4).
 * Colors are the vendored Hermes semantic tokens; geometry is the 10 section 4 contract.
 */

import type { DesktopThemeColors } from '@vendor/hermes/themes/types'

export type Appearance = 'system' | 'light' | 'dark'

export interface MobileTheme {
  name: string
  dark: boolean
  colors: DesktopThemeColors & { midground: string; userBubble: string }
  radius: typeof LEGACY_RADIUS
  spacing: readonly [4, 8, 12, 16, 24, 32]
  /**
   * Horizontal page gutter. Applied by `Screen` and `Sheet` only — rows,
   * section headings and the chat list sit inside an already-padded page and
   * must not add it again.
   */
  pagePadding: 20
  /** Minimum hit area for controls, in points. */
  hit: 44
}

/**
 * Corner radii of today's components, kept until each one points to a step of
 * `RADIUS`. Not a scale: every key is a component name.
 */
export const LEGACY_RADIUS = {
  bubble: 22,
  composer: 24,
  group: 20,
  sheet: 28,
  button: 16,
  field: 14,
  chip: 14,
  small: 12,
  badge: 6,
} as const

/**
 * Spacing steps in points, for padding, margin and gap. A component points to
 * a step; no step is named after a component.
 */
export const SPACE = {
  hairline: 2,
  extraSmall: 4,
  small: 8,
  medium: 12,
  large: 16,
  extraLarge: 20,
  huge: 24,
  giant: 32,
} as const

/**
 * Corner radius steps in points. A component points to a step; no step is
 * named after a component. `full` is a pill or a circle.
 */
export const RADIUS = {
  small: 8,
  medium: 12,
  large: 16,
  extraLarge: 20,
  huge: 24,
  giant: 28,
  full: 9999,
} as const

/** Icon glyph steps in points. A component points to a step; no step is named after a component. */
export const ICON_SIZE = { small: 16, medium: 20, large: 24 } as const

/** Width and height steps in points, for avatars, controls and rows. A component points to a step; no step is named after a component. */
export const SIZE = {
  tiny: 8,
  extraSmall: 20,
  small: 28,
  medium: 40,
  large: 48,
  extraLarge: 56,
  huge: 64,
  giant: 88,
} as const

/** Opacity steps from the most to the least visible. A component points to a step; no step is named after a component. */
export const OPACITY = { strong: 0.65, medium: 0.45, faint: 0.25 } as const

/**
 * Values that are neither a step nor drag geometry, named by what they mean.
 * `touch` is the smallest hit area and is never snapped to a step. A
 * component points to a rule; no rule is named after a component.
 */
export const RULE = {
  touch: 44,
  narrowScreen: 360,
  maxFontScale: 1.4,
  panelWidth: 240,
  textAreaMinHeight: 128,
  /** Window width below which a markdown table is drawn as stacked lines instead of columns. */
  stackedTableWidth: 400,
  /** The widest a short label, such as a role beside a name, grows before it truncates. */
  labelMaxWidth: 113,
  /** The widest a file name, such as an attachment waiting to be sent, grows before it truncates. */
  fileNameMaxWidth: 200,
  /** How high a floating control sits above the bottom of the screen, clear of a one-line input bar and the home indicator. */
  floatingBottom: 96,
} as const

export const SPACING = [4, 8, 12, 16, 24, 32] as const
export const PAGE_PADDING = 20

/** Control and row sizes of today's components, in points, kept until each one points to a step of `SIZE`; `hit` is the minimum touch target. */
export const LEGACY_SIZE = { hit: 44, row: 56, button: 50, field: 50, fieldMultiline: 128 } as const
export const HIT = LEGACY_SIZE.hit

export type TypeRole =
  | 'largeTitle'
  | 'title'
  | 'title3'
  | 'headline'
  | 'bodyStrong'
  | 'body'
  | 'calloutStrong'
  | 'callout'
  | 'footnote'
  | 'footnoteStrong'
  | 'caption'

/** Type scale from docs/10; size and weight only, because Home rows have fixed drag heights. */
export const TYPE = {
  largeTitle: { fontSize: 28, fontWeight: '600' },
  title: { fontSize: 22, fontWeight: '600' },
  title3: { fontSize: 20, fontWeight: '600' },
  headline: { fontSize: 17, fontWeight: '600' },
  bodyStrong: { fontSize: 17, fontWeight: '500' },
  body: { fontSize: 17, fontWeight: '400' },
  calloutStrong: { fontSize: 15, fontWeight: '600' },
  callout: { fontSize: 15, fontWeight: '400' },
  footnote: { fontSize: 13, fontWeight: '400' },
  footnoteStrong: { fontSize: 13, fontWeight: '600' },
  caption: { fontSize: 12, fontWeight: '400' },
} as const satisfies Record<TypeRole, { fontSize: number; fontWeight: '400' | '500' | '600' }>

/** Every type role, in the order of the type scale table. */
export const TYPE_ROLES: readonly TypeRole[] = [
  'largeTitle',
  'title',
  'title3',
  'headline',
  'bodyStrong',
  'body',
  'calloutStrong',
  'callout',
  'footnote',
  'footnoteStrong',
  'caption',
]

/** Line heights for the text that wraps over several lines (message body, callouts, footnotes). */
export const LEADING = { body: 24, callout: 22, footnote: 18 } as const

/** Icon glyph sizes in points. */
export const ICON = { row: 22, chevron: 17, small: 18 } as const

/** Avatar diameters in points, by where the avatar appears. */
export const AVATAR = {
  inline: 18,
  chat: 28,
  chatHeader: 30,
  list: 48,
  identity: 60,
  editor: 80,
  profile: 88,
  pinned: 84,
} as const

/** Opacity of a pressed and of a disabled control, kept until each control points to a step of `OPACITY`. */
export const LEGACY_OPACITY = { pressed: 0.65, disabled: 0.45 } as const

/** Backdrop behind the action menu; the one fixed color, identical on every theme. */
export const SCRIM = 'rgba(0,0,0,0.25)'
