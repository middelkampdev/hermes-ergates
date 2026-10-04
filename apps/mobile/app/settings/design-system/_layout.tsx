/**
 * Settings > Developer tools > Design system (docs/10 "Design system"): an
 * index page and one page per section, pushed inside the Settings modal.
 * Development builds only; a release build that is deep-linked here lands
 * on Settings.
 *
 * The whole stack sits in its own ThemeProvider with one local Mode and
 * Theme, set on the index, so a preview recolors every design-system page
 * edge to edge. The rest of the app keeps the saved Appearance, nothing is
 * written back, and the preview is dropped when the stack closes.
 */

import { Redirect, Stack } from 'expo-router'
import React, { useMemo, useState } from 'react'

import { nextAppearance, nextTheme } from '@/features/design-system'
import { isSelectedTheme } from '@/features/settings'
import { useDeviceStore } from '@/state/device-store'
import { ThemeProvider } from '@/theme/provider'
import { listMobileThemes } from '@/theme/resolve'
import { useSkinStore } from '@/theme/skin-store'
import type { Appearance } from '@/theme/tokens'
import { DesignSystemPreviewProvider, type DesignSystemPreview } from '@/ui/design-system'

export default function DesignSystemLayout() {
  if (!__DEV__) {
    return <Redirect href="/settings" />
  }
  return <PreviewStack />
}

function PreviewStack() {
  const prefs = useDeviceStore(s => s.prefs)
  const backend = useSkinStore(s => s.state.backend)
  const themes = useMemo(() => listMobileThemes(backend), [backend])
  // The stored name can be an alias (`default` is Nous); start from the listed name so the first Theme tap moves on.
  const savedTheme = themes.find(t => isSelectedTheme(prefs.themeName, t.name))?.name ?? prefs.themeName
  const [appearance, setAppearance] = useState<Appearance>(prefs.appearance)
  const [themeName, setThemeName] = useState(savedTheme)

  const preview = useMemo<DesignSystemPreview>(
    () => ({
      appearance,
      themeLabel: themes.find(t => isSelectedTheme(themeName, t.name))?.label ?? themeName,
      nextMode: () => setAppearance(nextAppearance(appearance)),
      nextTheme: () => setThemeName(nextTheme(themeName, themes.map(t => t.name))),
      reset: () => {
        setAppearance(prefs.appearance)
        setThemeName(savedTheme)
      }
    }),
    [appearance, themeName, themes, prefs.appearance, savedTheme]
  )

  return (
    <DesignSystemPreviewProvider value={preview}>
      <ThemeProvider appearance={appearance} themeName={themeName} backendThemes={backend}>
        <Stack screenOptions={{ headerShown: false }} />
      </ThemeProvider>
    </DesignSystemPreviewProvider>
  )
}
