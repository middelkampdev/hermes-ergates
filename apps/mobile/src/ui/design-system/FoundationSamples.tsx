/**
 * The Foundations pages of the Design system: every color (a tap copies the
 * token name), every contrast pair with its rating, the type scale, and the
 * space and shape tokens.
 */

import * as Clipboard from 'expo-clipboard'
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native'

import { colorSwatches, contrastRows, shapeRows, typeRows } from '@/features/design-system'
import { softFill } from '@/theme/fill'
import { useTheme } from '@/theme/provider'
import { RULE, SIZE, SPACE, TYPE } from '@/theme/tokens'

import { Group } from '../Group'
import { ListRow } from '../ListRow'
import { ContrastSample } from './ContrastSample'
import { Swatch } from './Swatch'
import { TypeSample } from './TypeSample'

async function copyToken(key: string) {
  try {
    await Clipboard.setStringAsync(key)
  } catch {
    // The copy is a convenience; a failed write shows nothing.
    return
  }
  AccessibilityInfo.announceForAccessibility(`Copied ${key}`)
}

export function ColorSamples() {
  const theme = useTheme()

  return (
    <Group iconless>
      {colorSwatches(theme.colors).map(({ key, value }) => (
        <Swatch key={key} name={key} value={value} onPress={() => void copyToken(key)} />
      ))}
    </Group>
  )
}

export function ContrastSamples() {
  const theme = useTheme()

  return (
    <Group iconless>
      {contrastRows(theme.colors).map(row => (
        <ContrastSample key={`${row.fg}/${row.bg}`} {...row} />
      ))}
    </Group>
  )
}

export function TypeSamples() {
  return (
    <Group iconless>
      {typeRows().map(({ role, label }) => (
        <TypeSample key={role} role={role} label={label} />
      ))}
    </Group>
  )
}

export function ShapeSamples() {
  const theme = useTheme()
  const shapes = shapeRows()
  const cardFill = softFill(theme.colors, theme.colors.background)
  const squareFill = softFill(theme.colors, cardFill)

  return (
    <>
      <Group caption="Spacing" iconless>
        {shapes.spacing.map(value => (
          <View key={value} style={styles.shapeRow} accessible accessibilityLabel={`Spacing ${value}`}>
            <View style={styles.slot}>
              <View style={[styles.bar, { width: value, backgroundColor: theme.colors.primary }]} />
            </View>
            <Text style={[styles.shapeName, { color: theme.colors.foreground }]}>{value}</Text>
          </View>
        ))}
      </Group>
      <Group caption="Radius" iconless>
        {shapes.radius.map(([name, value]) => (
          <View key={name} style={styles.shapeRow} accessible accessibilityLabel={`Radius ${name}, ${value}`}>
            <View style={[styles.square, { borderRadius: value, backgroundColor: squareFill, borderColor: theme.colors.border }]} />
            <View style={styles.shapeText}>
              <Text style={[styles.shapeName, { color: theme.colors.foreground }]}>{name}</Text>
              <Text style={[styles.shapeValue, { color: theme.colors.mutedForeground }]}>{value}</Text>
            </View>
          </View>
        ))}
      </Group>
      <Group caption="Sizes" iconless>
        {[...shapes.size.map(([name, value]) => [`Size ${name}`, value] as const), ...shapes.icon.map(([name, value]) => [`Icon ${name}`, value] as const)].map(([title, value]) => (
          <ListRow key={title} title={title} subtitle={`${value} pt`} />
        ))}
      </Group>
    </>
  )
}

const styles = StyleSheet.create({
  shapeRow: {
    minHeight: SIZE.extraLarge,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.medium,
    paddingHorizontal: SPACE.large,
    paddingVertical: SPACE.small
  },
  shapeText: {
    flex: 1,
    gap: SPACE.hairline
  },
  shapeName: {
    ...TYPE.body
  },
  shapeValue: {
    ...TYPE.footnote
  },
  // Bars and squares share one left column, so every label starts at the same edge.
  slot: {
    width: RULE.touch
  },
  bar: {
    height: SIZE.tiny
  },
  // The hairline keeps the shape visible where the fill is close to the card's (light themes).
  square: {
    width: RULE.touch,
    height: RULE.touch,
    borderWidth: StyleSheet.hairlineWidth
  }
})
