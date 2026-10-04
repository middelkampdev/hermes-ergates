/**
 * The ≡ glyph inside a drag handle. Hidden from screen readers, which use
 * Move up and Move down. `size` defaults to 22, the rows' and the section
 * headers' own glyph size; a caller with a differently sized handle (the
 * pinned avatars' move badge) passes its own size.
 */

import { View } from 'react-native'

import { useTheme } from '@/theme/provider'
import { ICON } from '@/theme/tokens'

import { Icon } from '../icons'

export function Grip({ size = ICON.row }: { size?: number }) {
  const theme = useTheme()
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Icon name="menu" size={size} color={theme.colors.mutedForeground} />
    </View>
  )
}
