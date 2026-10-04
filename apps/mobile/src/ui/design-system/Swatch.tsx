/**
 * One color of the palette on the Design system page: a 28 pt disc with a
 * hairline ring, the token name and its value. A value that is not a hex
 * color React Native can paint (a backend skin can send one) still gets its
 * row: the disc stays empty and the raw value is shown as text.
 */

import { Pressable, StyleSheet, Text, View } from 'react-native'

import { isRenderableHex } from '@/theme/color'
import { useTheme } from '@/theme/provider'
import { OPACITY, SIZE, SPACE, TYPE } from '@/theme/tokens'

export interface SwatchProps {
  name: string
  value: string
  onPress: () => void
}

export function Swatch({ name, value, onPress }: SwatchProps) {
  const theme = useTheme()
  const fill = isRenderableHex(value) ? value : 'transparent'

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={value ? `${name}, ${value}` : name}
      accessibilityHint="Copies the token name"
      style={({ pressed }) => [styles.row, { opacity: pressed ? OPACITY.strong : 1 }]}
    >
      <View style={[styles.disc, { backgroundColor: fill, borderColor: theme.colors.border }]} />
      <View style={styles.text}>
        <Text style={[styles.name, { color: theme.colors.foreground }]}>{name}</Text>
        <Text style={[styles.value, { color: theme.colors.mutedForeground }]}>{value}</Text>
      </View>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: SIZE.extraLarge,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.medium,
    paddingHorizontal: SPACE.large,
    paddingVertical: SPACE.small
  },
  disc: {
    width: SIZE.small,
    height: SIZE.small,
    borderRadius: SIZE.small / 2,
    borderWidth: StyleSheet.hairlineWidth
  },
  text: {
    flex: 1,
    gap: SPACE.hairline
  },
  name: {
    ...TYPE.body
  },
  value: {
    ...TYPE.footnote
  }
})
