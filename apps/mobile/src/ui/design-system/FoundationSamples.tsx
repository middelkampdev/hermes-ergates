/**
 * The Foundations pages of the Design system: every color (a tap copies the
 * token name), every contrast pair with its rating, the type scale, and the
 * step scales (space, radius, size, icon size, opacity) with the named rules.
 */

import * as Clipboard from 'expo-clipboard'
import type { ReactNode } from 'react'
import { AccessibilityInfo, StyleSheet, Text, View } from 'react-native'

import { colorSwatches, contrastRows, shapeRows, typeRows } from '@/features/design-system'
import { softFill } from '@/theme/fill'
import { useTheme } from '@/theme/provider'
import { RADIUS, SIZE, SPACE, TYPE } from '@/theme/tokens'

import { Group } from '../Group'
import { Icon } from '../icons'
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

/** The edge of a radius sample and of the column that holds it. */
const RADIUS_SAMPLE_SIZE = SIZE.huge

/** One step or rule: its drawing (if any) in a column of fixed width, then its name and value, so every label of a group starts at the same edge. */
function ShapeRow({ label, name, value, slotWidth, children }: { label: string; name: string; value: number; slotWidth?: number; children?: ReactNode }) {
  const theme = useTheme()

  return (
    <View style={styles.shapeRow} accessible accessibilityLabel={`${label} ${name}, ${value}`}>
      {slotWidth === undefined ? null : <View style={{ width: slotWidth }}>{children}</View>}
      <View style={styles.shapeText}>
        <Text style={[styles.shapeName, { color: theme.colors.foreground }]}>{name}</Text>
        <Text style={[styles.shapeValue, { color: theme.colors.mutedForeground }]}>{value}</Text>
      </View>
    </View>
  )
}

export function ShapeSamples() {
  const theme = useTheme()
  const shapes = shapeRows()
  const cardFill = softFill(theme.colors, theme.colors.background)
  const squareFill = softFill(theme.colors, cardFill)
  // The hairline keeps the shape visible where the fill is close to the card's (light themes).
  const outline = { backgroundColor: squareFill, borderColor: theme.colors.border, borderWidth: StyleSheet.hairlineWidth }

  return (
    <>
      <Group caption="Space" iconless>
        {shapes.space.map(([name, value]) => (
          <ShapeRow key={name} label="Space" name={name} value={value} slotWidth={SIZE.medium}>
            <View style={[styles.bar, { width: value, backgroundColor: theme.colors.primary }]} />
          </ShapeRow>
        ))}
      </Group>
      <Group caption="Radius" iconless>
        {shapes.radius.map(([name, value]) => (
          <ShapeRow key={name} label="Radius" name={name} value={value} slotWidth={RADIUS_SAMPLE_SIZE}>
            <View style={[styles.radiusSample, value === RADIUS.full && styles.pill, outline, { borderRadius: value }]} />
          </ShapeRow>
        ))}
      </Group>
      <Group caption="Size" iconless>
        {shapes.size.map(([name, value]) => (
          <ShapeRow key={name} label="Size" name={name} value={value} slotWidth={SIZE.giant}>
            <View style={[outline, { width: value, height: value }]} />
          </ShapeRow>
        ))}
      </Group>
      <Group caption="Icon size" iconless>
        {shapes.iconSize.map(([name, value]) => (
          <ShapeRow key={name} label="Icon size" name={name} value={value} slotWidth={SIZE.medium}>
            <Icon name="star" size={value} color={theme.colors.foreground} />
          </ShapeRow>
        ))}
      </Group>
      <Group caption="Opacity" iconless>
        {shapes.opacity.map(([name, value]) => (
          <ShapeRow key={name} label="Opacity" name={name} value={value} slotWidth={SIZE.medium}>
            <View style={[styles.opacitySample, { backgroundColor: theme.colors.primary, opacity: value }]} />
          </ShapeRow>
        ))}
      </Group>
      <Group caption="Rules" iconless>
        {shapes.rules.map(([name, value]) => (
          <ShapeRow key={name} label="Rule" name={name} value={value} />
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
  bar: {
    height: SIZE.tiny
  },
  radiusSample: {
    width: RADIUS_SAMPLE_SIZE,
    height: RADIUS_SAMPLE_SIZE
  },
  // A full radius is a pill or a circle: a wide, shorter shape shows that.
  pill: {
    height: SIZE.medium
  },
  opacitySample: {
    width: SIZE.medium,
    height: SIZE.medium,
    borderRadius: RADIUS.small
  }
})
