/**
 * The Appearance choice (docs/10 "Settings and agent details"): System,
 * Light or Dark, then the theme list, with a check mark on the current
 * choice. Settings › Appearance saves the choice; the Design system preview
 * uses the same picker for its own, unsaved choice.
 */

import React from 'react'
import { StyleSheet, View } from 'react-native'

import { APPEARANCE_LABELS, isSelectedTheme, type AppearanceMode } from '@/features/settings'
import { useTheme } from '@/theme/provider'
import { ICON_SIZE } from '@/theme/tokens'

import { Group } from './Group'
import { Icon, type IconName } from './icons'
import { ListRow } from './ListRow'

const MODES: { mode: AppearanceMode; icon: IconName }[] = [
  { mode: 'system', icon: 'smartphone' },
  { mode: 'light', icon: 'sun' },
  { mode: 'dark', icon: 'moon' }
]

export interface AppearancePickerProps {
  appearance: AppearanceMode
  themeName: string
  themes: { name: string; label: string }[]
  onAppearanceChange: (appearance: AppearanceMode) => void
  onThemeChange: (themeName: string) => void
}

export function AppearancePicker({ appearance, themeName, themes, onAppearanceChange, onThemeChange }: AppearancePickerProps) {
  const theme = useTheme()
  const check = (on: boolean) => (on ? <Icon name="check" size={ICON_SIZE.medium} color={theme.colors.primary} /> : <View style={styles.noCheck} />)

  return (
    <>
      <Group caption="Appearance">
        {MODES.map(({ mode, icon }) => (
          <ListRow
            key={mode}
            title={APPEARANCE_LABELS[mode]}
            icon={icon}
            selected={appearance === mode}
            right={check(appearance === mode)}
            onPress={() => onAppearanceChange(mode)}
          />
        ))}
      </Group>
      <Group caption="Theme">
        {themes.map(t => (
          <ListRow
            key={t.name}
            title={t.label}
            icon="droplet"
            selected={isSelectedTheme(themeName, t.name)}
            right={check(isSelectedTheme(themeName, t.name))}
            onPress={() => onThemeChange(t.name)}
          />
        ))}
      </Group>
    </>
  )
}

const styles = StyleSheet.create({
  noCheck: { width: ICON_SIZE.medium }
})
