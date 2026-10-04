/**
 * A group of `ListRow`s (docs/10 section 4): a `muted` card with radius 20
 * and hairline dividers inset past the row icon, under an optional small
 * caption.
 */

import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { useTheme } from '@/theme/provider'
import { ICON_SIZE, SPACE, TYPE } from '@/theme/tokens'

import { Card } from './Card'

/** A `ListRow`'s padding, icon and gap: the divider starts under the row text. */
const DIVIDER_INSET = SPACE.large + ICON_SIZE.medium + SPACE.medium
/** Rows without an icon start their text at the row padding. */
const ICONLESS_DIVIDER_INSET = SPACE.large

export interface GroupProps {
  caption?: string
  /** True when the rows have no leading icon: dividers start at the row padding. */
  iconless?: boolean
  children: ReactNode
}

export function Group({ caption, iconless, children }: GroupProps) {
  const theme = useTheme()
  return (
    <View style={styles.group}>
      {caption ? <Text style={[styles.caption, { color: theme.colors.mutedForeground }]}>{caption}</Text> : null}
      <Card dividerInset={iconless ? ICONLESS_DIVIDER_INSET : DIVIDER_INSET}>{children}</Card>
    </View>
  )
}

const styles = StyleSheet.create({
  group: {
    gap: SPACE.small
  },
  caption: {
    ...TYPE.footnote,
    paddingHorizontal: SPACE.extraSmall
  }
})
