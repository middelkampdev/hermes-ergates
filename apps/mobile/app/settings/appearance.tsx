/**
 * Settings > Appearance (docs/10 "Settings and agent details"): System, Light
 * or Dark, and the theme list. A check mark shows the current choice; every
 * choice applies at once and stays on this phone.
 */

import { useRouter } from 'expo-router'
import React from 'react'

import { useDeviceStore } from '@/state/device-store'
import { listMobileThemes } from '@/theme/resolve'
import { useSkinStore } from '@/theme/skin-store'
import { AppearancePicker } from '@/ui/AppearancePicker'
import { Page } from '@/ui/Page'

export default function AppearanceSettingsScreen() {
  const router = useRouter()
  const prefs = useDeviceStore(s => s.prefs)
  const setPrefs = useDeviceStore(s => s.setPrefs)
  const backend = useSkinStore(s => s.state.backend)

  return (
    <Page title="Appearance" onBack={() => router.back()}>
      <AppearancePicker
        appearance={prefs.appearance}
        themeName={prefs.themeName}
        themes={listMobileThemes(backend)}
        onAppearanceChange={appearance => setPrefs({ appearance })}
        onThemeChange={themeName => setPrefs({ themeName })}
      />
    </Page>
  )
}
