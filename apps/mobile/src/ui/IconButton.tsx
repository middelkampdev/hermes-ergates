/**
 * Icon-only control (docs/10 section 4): no border and no circle, a 44x44
 * hit area around the icon. `filled` draws a `muted` disc behind the icon
 * for a quieter emphasis state.
 */

import { Pressable, StyleSheet } from 'react-native'

import { useTheme } from '@/theme/provider'
import { ICON_SIZE, OPACITY, RULE } from '@/theme/tokens'

import { Icon, type IconName } from './icons'

export interface IconButtonProps {
  name: IconName
  onPress: () => void
  accessibilityLabel: string
  size?: number
  filled?: boolean
  disabled?: boolean
}

export function IconButton({ name, onPress, accessibilityLabel, size = ICON_SIZE.medium, filled, disabled }: IconButtonProps) {
  const theme = useTheme()

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => [
        styles.hitArea,
        { width: RULE.touch, height: RULE.touch },
        filled ? { backgroundColor: theme.colors.muted, borderRadius: RULE.touch / 2 } : null,
        { opacity: disabled ? OPACITY.medium : pressed ? OPACITY.strong : 1 }
      ]}
    >
      <Icon name={name} size={size} color={theme.colors.foreground} />
    </Pressable>
  )
}

const styles = StyleSheet.create({
  hitArea: {
    alignItems: 'center',
    justifyContent: 'center'
  }
})
