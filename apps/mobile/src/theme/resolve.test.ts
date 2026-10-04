import { describe, expect, it } from 'vitest'

import { isMobileRenderable, listMobileThemes, resolvePalette } from './resolve'
import { BUILTIN_THEMES } from '@vendor/hermes/themes/presets'

describe('resolvePalette', () => {
  it('returns Nous light by default', () => {
    const t = resolvePalette({ themeName: 'default', appearance: 'system', systemDark: false })
    expect(t.name).toBe('nous')
    expect(t.dark).toBe(false)
    expect(t.colors.primary).toBe('#0053fd')
    expect(t.colors.userBubble).toBe('#dae7fd')
    expect(t.colors.midground).toBe('#0053fd')
  })
  it('returns Nous dark when the system is dark or the user forces dark', () => {
    expect(resolvePalette({ themeName: 'nous', appearance: 'system', systemDark: true }).colors.primary).toBe('#4a84fe')
    expect(resolvePalette({ themeName: 'nous', appearance: 'dark', systemDark: false }).colors.background).toBe('#0d1117')
    expect(resolvePalette({ themeName: 'nous', appearance: 'light', systemDark: true }).colors.background).toBe('#ffffff')
  })
  it('maps unknown names to Nous', () => {
    expect(resolvePalette({ themeName: 'does-not-exist', appearance: 'light', systemDark: false }).name).toBe('nous')
  })
  it('uses the single palette of a dark-only built-in in both appearances', () => {
    const light = resolvePalette({ themeName: 'midnight', appearance: 'light', systemDark: false })
    const dark = resolvePalette({ themeName: 'midnight', appearance: 'dark', systemDark: true })
    expect(light.colors.background).toBe(dark.colors.background)
  })
  it('carries the name, the appearance and the colors, and no geometry', () => {
    const t = resolvePalette({ themeName: 'nous', appearance: 'light', systemDark: false })
    expect(Object.keys(t).sort()).toEqual(['colors', 'dark', 'name'])
  })
})

describe('listMobileThemes', () => {
  it('excludes nous-alt (color-mix) and includes backend skins', () => {
    const names = listMobileThemes({ ocean: { ...BUILTIN_THEMES.nous!, name: 'ocean', label: 'Ocean' } }).map(t => t.name)
    expect(names).toContain('nous')
    expect(names).toContain('ocean')
    expect(names).not.toContain('nous-alt')
    expect(isMobileRenderable(BUILTIN_THEMES['nous-alt']!)).toBe(false)
  })
})
