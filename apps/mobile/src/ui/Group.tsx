/**
 * A group of `ListRow`s (docs/10 section 4): a `muted` card with radius 20
 * and hairline dividers inset past the row icon, under an optional small
 * caption.
 */

import type { ReactNode } from 'react'
import { StyleSheet, Text, View } from 'react-native'

import { useTheme } from '@/theme/provider'
import { TYPE } from '@/theme/tokens'

import { Card } from './Card'

/** Row padding 16 + icon 22 + gap 12, plus 2: the divider starts under the row text. */
const DIVIDER_INSET = 52

export interface GroupProps {
  caption?: string
  children: ReactNode
}

export function Group({ caption, children }: GroupProps) {
  const theme = useTheme()
  return (
    <View style={styles.group}>
      {caption ? <Text style={[styles.caption, { color: theme.colors.mutedForeground }]}>{caption}</Text> : null}
      <Card dividerInset={DIVIDER_INSET}>{children}</Card>
    </View>
  )
}

const styles = StyleSheet.create({
  group: {
    gap: 8
  },
  caption: {
    ...TYPE.footnote,
    paddingHorizontal: 4
  }
})
