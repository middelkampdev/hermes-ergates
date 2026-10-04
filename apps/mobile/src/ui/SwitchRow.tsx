/**
 * Settings switch row (docs/10 section 4: settings row min height 48). Sits
 * transparent so the caller can wrap a group of these in `Card` for the
 * grouped-row look. `Toggle` is the themed switch on its own, for a
 * `ListRow`'s right side.
 */

import { Platform, StyleSheet, Switch, Text, View } from 'react-native'

import { useTheme } from '@/theme/provider'
import { RULE, SIZE, SPACE, TYPE } from '@/theme/tokens'

export interface ToggleProps {
  value: boolean
  onValueChange: (value: boolean) => void
  disabled?: boolean
  accessibilityLabel: string
}

export function Toggle({ value, onValueChange, disabled, accessibilityLabel }: ToggleProps) {
  const theme = useTheme()
  return (
    <Switch
      // iOS 26 draws the native switch about 12pt above the frame React Native
      // lays out for it (measured on the simulator), so it sat above its label.
      style={styles.switch}
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      trackColor={{ false: theme.colors.border, true: theme.colors.primary }}
      thumbColor={theme.colors.background}
    />
  )
}

export interface SwitchRowProps {
  label: string
  description?: string
  value: boolean
  onValueChange: (value: boolean) => void
  disabled?: boolean
  accessibilityLabel?: string
}

export function SwitchRow({ label, description, value, onValueChange, disabled, accessibilityLabel }: SwitchRowProps) {
  const theme = useTheme()

  return (
    <View style={[styles.row, { minHeight: Math.max(RULE.touch, SIZE.large) }]}>
      <View style={styles.text}>
        <Text style={[styles.label, { color: theme.colors.foreground }]}>{label}</Text>
        {description ? (
          <Text style={[styles.description, { color: theme.colors.mutedForeground }]}>{description}</Text>
        ) : null}
      </View>
      <Toggle value={value} onValueChange={onValueChange} disabled={disabled} accessibilityLabel={accessibilityLabel ?? label} />
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACE.medium,
    paddingHorizontal: SPACE.large
  },
  text: {
    flex: 1,
    gap: SPACE.hairline
  },
  label: {
    ...TYPE.body
  },
  description: {
    ...TYPE.footnote
  },
  switch: {
    height: RULE.switchHeight,
    ...Platform.select({ ios: { transform: [{ translateY: 12 }] }, default: {} })
  }
})
