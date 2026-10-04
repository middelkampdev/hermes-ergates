/**
 * Settings > Developer tools > Design system (docs/10 "Design system"): a
 * specimen of every color, contrast pair, type role, space and shape token
 * and shared component. Development builds only; a release build that is
 * deep-linked here lands on Settings.
 *
 * The whole page, header included, sits in its own ThemeProvider with a
 * local Mode and Theme, so a preview recolors this page edge to edge. The
 * rest of the app keeps the saved Appearance, nothing is written back, and
 * the preview is dropped when the page closes.
 */

import * as Clipboard from 'expo-clipboard'
import { Redirect, useRouter } from 'expo-router'
import React, { useState } from 'react'
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native'

import { colorSwatches, contrastRows, nextAppearance, nextTheme, shapeRows, typeRows } from '@/features/design-system'
import { APPEARANCE_LABELS, isSelectedTheme } from '@/features/settings'
import { useDeviceStore } from '@/state/device-store'
import { softFill } from '@/theme/fill'
import { ThemeProvider, useTheme } from '@/theme/provider'
import { listMobileThemes } from '@/theme/resolve'
import { useSkinStore } from '@/theme/skin-store'
import { SIZE, TYPE, type Appearance } from '@/theme/tokens'
import { ComponentSamples, ContrastSample, Swatch, TypeSample } from '@/ui/design-system'
import { Group } from '@/ui/Group'
import { ListRow } from '@/ui/ListRow'
import { Page } from '@/ui/Page'

const BAR_HEIGHT = 8

export default function DesignSystemScreen() {
  if (!__DEV__) {
    return <Redirect href="/settings" />
  }
  return <DesignSystemPage />
}

function DesignSystemPage() {
  const router = useRouter()
  const prefs = useDeviceStore(s => s.prefs)
  const backend = useSkinStore(s => s.state.backend)
  const themes = listMobileThemes(backend)
  // The stored name can be an alias (`default` is Nous); start from the listed name so the first Theme tap moves on.
  const savedTheme = themes.find(t => isSelectedTheme(prefs.themeName, t.name))?.name ?? prefs.themeName
  const [appearance, setAppearance] = useState<Appearance>(prefs.appearance)
  const [themeName, setThemeName] = useState(savedTheme)
  const themeLabel = themes.find(t => isSelectedTheme(themeName, t.name))?.label ?? themeName

  const reset = () => {
    setAppearance(prefs.appearance)
    setThemeName(savedTheme)
  }

  return (
    <ThemeProvider appearance={appearance} themeName={themeName} backendThemes={backend}>
      <Page title="Design system" onBack={() => router.back()}>
        <Group caption="Preview">
          <ListRow title="Mode" subtitle={APPEARANCE_LABELS[appearance]} icon="sun" onPress={() => setAppearance(nextAppearance(appearance))} />
          <ListRow title="Theme" subtitle={themeLabel} icon="droplet" onPress={() => setThemeName(nextTheme(themeName, themes.map(t => t.name)))} />
          <ListRow title="Reset" subtitle="Back to the saved Appearance" icon="rotate-ccw" onPress={reset} />
        </Group>
        <Specimen />
      </Page>
    </ThemeProvider>
  )
}

async function copyToken(key: string) {
  try {
    await Clipboard.setStringAsync(key)
  } catch {
    // The copy is a convenience; a failed write shows nothing.
    return
  }
  AccessibilityInfo.announceForAccessibility(`Copied ${key}`)
}

function Specimen() {
  const theme = useTheme()
  const shapes = shapeRows()
  const cardFill = softFill(theme.colors, theme.colors.background)
  const squareFill = softFill(theme.colors, cardFill)

  return (
    <>
      <Group caption="Colors" iconless>
        {colorSwatches(theme.colors).map(({ key, value }) => (
          <Swatch key={key} name={key} value={value} onPress={() => void copyToken(key)} />
        ))}
      </Group>

      <Group caption="Contrast" iconless>
        {contrastRows(theme.colors).map(row => (
          <ContrastSample key={`${row.fg}/${row.bg}`} {...row} />
        ))}
      </Group>

      <Group caption="Type" iconless>
        {typeRows().map(({ role, label }) => (
          <TypeSample key={role} role={role} label={label} />
        ))}
      </Group>

      <Group caption="Space and shape" iconless>
        {shapes.spacing.map(value => (
          <View key={`spacing-${value}`} style={styles.shapeRow} accessible accessibilityLabel={`Spacing ${value}`}>
            <View style={styles.slot}>
              <View style={[styles.bar, { width: value, backgroundColor: theme.colors.primary }]} />
            </View>
            <Text style={[styles.shapeName, { color: theme.colors.foreground }]}>Spacing {value}</Text>
          </View>
        ))}
        {shapes.radius.map(([name, value]) => (
          <View key={`radius-${name}`} style={styles.shapeRow} accessible accessibilityLabel={`Radius ${name}, ${value}`}>
            <View style={[styles.square, { borderRadius: value, backgroundColor: squareFill }]} />
            <View style={styles.shapeText}>
              <Text style={[styles.shapeName, { color: theme.colors.foreground }]}>Radius {name}</Text>
              <Text style={[styles.shapeValue, { color: theme.colors.mutedForeground }]}>{value}</Text>
            </View>
          </View>
        ))}
        {[...shapes.size.map(([name, value]) => [`Size ${name}`, value] as const), ...shapes.icon.map(([name, value]) => [`Icon ${name}`, value] as const)].map(([title, value]) => (
          <ListRow key={title} title={title} subtitle={`${value} pt`} />
        ))}
      </Group>

      <ComponentSamples />
    </>
  )
}

const styles = StyleSheet.create({
  shapeRow: {
    minHeight: SIZE.row,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  shapeText: {
    flex: 1,
    gap: 2
  },
  shapeName: {
    ...TYPE.body
  },
  shapeValue: {
    ...TYPE.footnote
  },
  // Bars and squares share one left column, so every label starts at the same edge.
  slot: {
    width: SIZE.hit
  },
  bar: {
    height: BAR_HEIGHT
  },
  square: {
    width: SIZE.hit,
    height: SIZE.hit
  }
})
