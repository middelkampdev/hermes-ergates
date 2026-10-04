/**
 * The Design system preview's Appearance: the same picker as Settings ›
 * Appearance, but the choice only recolors the design-system pages and is
 * not saved.
 */

import { useRouter } from 'expo-router'
import React from 'react'
import { StyleSheet, Text } from 'react-native'

import { useTheme } from '@/theme/provider'
import { LEADING, SPACE, TYPE } from '@/theme/tokens'
import { AppearancePicker } from '@/ui/AppearancePicker'
import { useDesignSystemPreview } from '@/ui/design-system'
import { Page } from '@/ui/Page'

export default function DesignSystemAppearance() {
  const router = useRouter()
  const theme = useTheme()
  const preview = useDesignSystemPreview()

  return (
    <Page title="Appearance" onBack={() => router.back()}>
      <Text style={[styles.hint, { color: theme.colors.mutedForeground }]}>
        Previews the design system pages only. Your Appearance in Settings stays as it is.
      </Text>
      <AppearancePicker
        appearance={preview.appearance}
        themeName={preview.themeName}
        themes={preview.themes}
        onAppearanceChange={preview.setAppearance}
        onThemeChange={preview.setThemeName}
      />
    </Page>
  )
}

const styles = StyleSheet.create({
  hint: { ...TYPE.callout, lineHeight: LEADING.callout, paddingHorizontal: SPACE.extraSmall }
})
