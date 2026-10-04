/**
 * Icon facade (docs/10 section 4): thin outline icons from the Feather set.
 * Callers import `Icon` and `IconName` from here, never the icon package,
 * so the backing set can change in one file.
 */

import { Feather } from '@expo/vector-icons'
import React, { type ComponentProps } from 'react'
import type { StyleProp, TextStyle } from 'react-native'

import { ICON_SIZE } from '@/theme/tokens'

export type IconName = ComponentProps<typeof Feather>['name']

export interface IconProps {
  name: IconName
  /** Point size. Default `ICON_SIZE.medium`. */
  size?: number
  color: string
  style?: StyleProp<TextStyle>
}

/** Decorative by default; the owning control carries the accessibility label. */
export function Icon({ name, size = ICON_SIZE.medium, color, style }: IconProps) {
  return <Feather name={name} size={size} color={color} style={style} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" />
}
