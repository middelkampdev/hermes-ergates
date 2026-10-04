/**
 * Settings > Appearance (docs/10 "Settings and agent details"): System, Light
 * or Dark, and the theme list. A check mark shows the current choice; every
 * choice applies at once and stays on this phone.
 */

import { useRouter } from 'expo-router'
import React from 'react'
import { StyleSheet, View } from 'react-native'

import { APPEARANCE_LABELS, isSelectedTheme, type AppearanceMode } from '@/features/settings'
import { useDeviceStore } from '@/state/device-store'
import { useTheme } from '@/theme/provider'
import { listMobileThemes } from '@/theme/resolve'
import { useSkinStore } from '@/theme/skin-store'
import { ICON } from '@/theme/tokens'
import { Group } from '@/ui/Group'
import { Icon, type IconName } from '@/ui/icons'
import { ListRow } from '@/ui/ListRow'
import { Page } from '@/ui/Page'

const MODES: { mode: AppearanceMode; icon: IconName }[] = [
  { mode: 'system', icon: 'smartphone' },
  { mode: 'light', icon: 'sun' },
  { mode: 'dark', icon: 'moon' }
]

export default function AppearanceSettingsScreen() {
  const router = useRouter()
  const theme = useTheme()
  const prefs = useDeviceStore(s => s.prefs)
  const setPrefs = useDeviceStore(s => s.setPrefs)
  const backend = useSkinStore(s => s.state.backend)
  const check = (on: boolean) => (on ? <Icon name="check" size={ICON.row} color={theme.colors.primary} /> : <View style={styles.noCheck} />)

  return (
    <Page title="Appearance" onBack={() => router.back()}>
      <Group caption="Appearance">
        {MODES.map(({ mode, icon }) => (
          <ListRow
            key={mode}
            title={APPEARANCE_LABELS[mode]}
            icon={icon}
            selected={prefs.appearance === mode}
            right={check(prefs.appearance === mode)}
            onPress={() => setPrefs({ appearance: mode })}
          />
        ))}
      </Group>
      <Group caption="Theme">
        {listMobileThemes(backend).map(t => (
          <ListRow
            key={t.name}
            title={t.label}
            icon="droplet"
            selected={isSelectedTheme(prefs.themeName, t.name)}
            right={check(isSelectedTheme(prefs.themeName, t.name))}
            onPress={() => setPrefs({ themeName: t.name })}
          />
        ))}
      </Group>
    </Page>
  )
}

const styles = StyleSheet.create({
  noCheck: { width: ICON.row }
})
