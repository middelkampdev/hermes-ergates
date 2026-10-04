/**
 * Settings-style row (docs/10 section 4): a leading line icon, the title, an
 * optional subtitle below, and a chevron on the right when the row opens
 * something. Minimum height 56. `right` replaces the chevron (a switch, a
 * check mark). Sits transparent inside a `Group`.
 */

import type { ReactNode } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import { useTheme } from '@/theme/provider'
import { ICON_SIZE, OPACITY, SIZE, SPACE, TYPE } from '@/theme/tokens'

import { Icon, type IconName } from './icons'

export interface ListRowProps {
  title: string
  subtitle?: string
  icon?: IconName
  /** Red text under the subtitle, for a value that needs attention. */
  error?: string
  onPress?: () => void
  right?: ReactNode
  destructive?: boolean
  /** Announced as selected by the screen reader (a check-marked choice). */
  selected?: boolean
  /** Announced as expanded or collapsed by the screen reader (a disclosure row). */
  expanded?: boolean
  accessibilityLabel?: string
}

export function ListRow({ title, subtitle, icon, error, onPress, right, destructive, selected, expanded, accessibilityLabel }: ListRowProps) {
  const theme = useTheme()
  const titleColor = destructive ? theme.colors.destructive : theme.colors.foreground
  const label = accessibilityLabel ?? [title, subtitle, error].filter(Boolean).join(', ')

  const content = (
    <View style={styles.row}>
      {icon ? <Icon name={icon} size={ICON_SIZE.medium} color={titleColor} /> : null}
      <View style={styles.text}>
        <Text style={[styles.title, { color: titleColor }]}>{title}</Text>
        {subtitle ? <Text style={[styles.subtitle, { color: theme.colors.mutedForeground }]}>{subtitle}</Text> : null}
        {error ? <Text style={[styles.subtitle, { color: theme.colors.destructive }]}>{error}</Text> : null}
      </View>
      {right ?? (onPress ? <Icon name="chevron-right" size={ICON_SIZE.small} color={theme.colors.mutedForeground} /> : null)}
    </View>
  )

  if (!onPress) {
    // A row with its own control (a switch) stays open to the screen reader,
    // so the control can be reached; an accessible container would hide it.
    return right ? (
      content
    ) : (
      <View accessible accessibilityLabel={label}>
        {content}
      </View>
    )
  }
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected === undefined && expanded === undefined ? undefined : { ...(selected !== undefined ? { selected } : {}), ...(expanded !== undefined ? { expanded } : {}) }}
      style={({ pressed }) => ({ opacity: pressed ? OPACITY.strong : 1 })}
    >
      {content}
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
    paddingVertical: SPACE.medium
  },
  text: {
    flex: 1,
    gap: SPACE.hairline
  },
  title: {
    ...TYPE.body
  },
  subtitle: {
    ...TYPE.footnote
  }
})
