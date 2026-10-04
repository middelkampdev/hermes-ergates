/**
 * The selection circle, iOS Mail style: an empty ring when not selected, a
 * filled `primary` circle with a `primaryForeground` check when selected.
 * On a row the ring is `mutedForeground`, softened, so it stays quieter than
 * the row text; on a pinned avatar (`onAvatar`) it sits on the page
 * background, so it reads on a photo too. Decorative: the row's or avatar's
 * label already ends in "selected" or "not selected".
 */

import { StyleSheet, View } from 'react-native'

import { useTheme } from '@/theme/provider'
import { OPACITY } from '@/theme/tokens'

import { Icon } from '../icons'
import { CIRCLE_SIZE } from './row-offsets'

const CIRCLE_RING = 1.5

export function SelectionCircle({ selected, size = CIRCLE_SIZE, onAvatar = false }: { selected: boolean; size?: number; onAvatar?: boolean }) {
  const theme = useTheme()
  const ring = onAvatar
    ? { borderWidth: CIRCLE_RING, borderColor: theme.colors.mutedForeground, backgroundColor: theme.colors.background }
    : { borderWidth: CIRCLE_RING, borderColor: theme.colors.mutedForeground, opacity: OPACITY.medium }
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[styles.circle, { width: size, height: size, borderRadius: size / 2 }, selected ? { backgroundColor: theme.colors.primary } : ring]}
    >
      {selected ? <Icon name="check" size={Math.round(size * 0.68)} color={theme.colors.primaryForeground} /> : null}
    </View>
  )
}

const styles = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' }
})
