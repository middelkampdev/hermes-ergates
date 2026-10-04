/**
 * Palette resolution: built-in Hermes desktop presets (vendored) plus
 * backend skins converted with the vendored skin converter. Pure; no
 * React Native imports.
 */

import { normalizeHex } from '@vendor/hermes/themes/color'
import { BUILTIN_THEMES, DEFAULT_SKIN_NAME } from '@vendor/hermes/themes/presets'
import type { DesktopTheme, DesktopThemeColors } from '@vendor/hermes/themes/types'

import { HIT, PAGE_PADDING, LEGACY_RADIUS, SPACING, type Appearance, type MobileTheme } from './tokens'

export type BackendThemes = Record<string, DesktopTheme>

/** True when every defined color is a hex value React Native can paint. */
export function isMobileRenderable(theme: DesktopTheme): boolean {
  const palettes = [theme.colors, theme.darkColors].filter(Boolean) as DesktopThemeColors[]
  return palettes.every(p => Object.values(p).every(v => typeof v !== 'string' || normalizeHex(v) !== null))
}

/** Built-ins the phone can render (nous-alt uses CSS color-mix and is excluded), then backend skins. */
export function listMobileThemes(backend: BackendThemes = {}): { name: string; label: string }[] {
  const builtins = Object.values(BUILTIN_THEMES)
    .filter(isMobileRenderable)
    .map(t => ({ name: t.name, label: t.label }))
  const extra = Object.values(backend)
    .filter(t => !BUILTIN_THEMES[t.name] && isMobileRenderable(t))
    .map(t => ({ name: t.name, label: t.label }))
  return [...builtins, ...extra]
}

export function resolveDesktopTheme(themeName: string, backend: BackendThemes = {}): DesktopTheme {
  const name = (themeName || '').trim()
  if (!name || name === 'default') {
    return BUILTIN_THEMES[DEFAULT_SKIN_NAME]!
  }
  const builtin = BUILTIN_THEMES[name]
  if (builtin && isMobileRenderable(builtin)) {
    return builtin
  }
  const remote = backend[name]
  if (remote && isMobileRenderable(remote)) {
    return remote
  }
  return BUILTIN_THEMES[DEFAULT_SKIN_NAME]!
}

export function isDarkAppearance(appearance: Appearance, systemDark: boolean): boolean {
  return appearance === 'dark' || (appearance === 'system' && systemDark)
}

function withFallbacks(colors: DesktopThemeColors): MobileTheme['colors'] {
  const flat: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(colors)) {
    if (typeof value === 'string') {
      flat[key] = normalizeHex(value, colors.background) ?? undefined
    }
  }
  const base = flat as unknown as DesktopThemeColors
  return {
    ...base,
    midground: base.midground ?? base.ring ?? base.primary,
    userBubble: base.userBubble ?? base.secondary ?? base.accent
  }
}

export function resolvePalette(p: { themeName: string; appearance: Appearance; systemDark: boolean; backend?: BackendThemes }): MobileTheme {
  const theme = resolveDesktopTheme(p.themeName, p.backend)
  const dark = isDarkAppearance(p.appearance, p.systemDark)
  const colors = dark && theme.darkColors ? theme.darkColors : theme.colors
  return {
    name: theme.name,
    dark,
    colors: withFallbacks(colors),
    radius: LEGACY_RADIUS,
    spacing: SPACING,
    pagePadding: PAGE_PADDING,
    hit: HIT
  }
}
