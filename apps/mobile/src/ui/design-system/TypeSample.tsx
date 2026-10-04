/** One role of the type scale on the Design system page: the role name set in that role, and its "size / weight" below. */

import { StyleSheet, Text, View } from 'react-native'

import { useTheme } from '@/theme/provider'
import { LEGACY_SIZE, TYPE, type TypeRole } from '@/theme/tokens'

export interface TypeSampleProps {
  role: TypeRole
  label: string
}

export function TypeSample({ role, label }: TypeSampleProps) {
  const theme = useTheme()

  return (
    <View style={styles.row} accessible accessibilityLabel={`${role}, ${label}`}>
      <Text style={[TYPE[role], { color: theme.colors.foreground }]}>{role}</Text>
      <Text style={[styles.label, { color: theme.colors.mutedForeground }]}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: LEGACY_SIZE.row,
    justifyContent: 'center',
    gap: 3,
    paddingHorizontal: 16,
    paddingVertical: 10
  },
  label: {
    ...TYPE.footnote
  }
})
