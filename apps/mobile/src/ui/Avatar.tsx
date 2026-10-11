/**
 * Circular avatar (docs/10 section 4): a photo when given, else initials on
 * a colored disc. Foreground text picks whichever theme foreground token
 * contrasts best against the disc color, using the vendored WCAG contrast
 * helper rather than a hardcoded light/dark guess.
 */

import { Image } from 'expo-image'
import { StyleSheet, Text, View } from 'react-native'

import { contrastRatio } from '@vendor/hermes/shared/color'
import { useTheme } from '@/theme/provider'
import { TYPE } from '@/theme/tokens'

export interface AvatarProps {
  name: string
  /** Disc color when there is no image. Defaults to the theme's userBubble token. */
  color?: string
  imageUri?: string | null
  size: number
}

/**
 * First letters of up to the first two words, uppercased. Indexed through
 * `Array.from` so an emoji or other astral character yields the whole glyph
 * instead of half a surrogate pair.
 */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  return words
    .slice(0, 2)
    .map(w => (Array.from(w)[0] ?? '').toUpperCase())
    .join('')
}

export function Avatar({ name, color, imageUri, size }: AvatarProps) {
  const theme = useTheme()
  const disc = color ?? theme.colors.userBubble
  // The helper answers null for a color it cannot parse; that counts as no contrast.
  const foreground =
    (contrastRatio(theme.colors.foreground, disc) ?? 0) >= (contrastRatio(theme.colors.primaryForeground, disc) ?? 0)
      ? theme.colors.foreground
      : theme.colors.primaryForeground

  const dimension = { width: size, height: size, borderRadius: size / 2 }

  return (
    <View
      accessible
      accessibilityLabel={name}
      style={[styles.container, dimension, imageUri ? null : { backgroundColor: disc }]}
    >
      {imageUri ? (
        <Image source={{ uri: imageUri }} style={dimension} contentFit="cover" accessible={false} />
      ) : (
        <Text
          allowFontScaling
          style={[styles.initials, { color: foreground, fontSize: Math.round(size * 0.4) }]}
        >
          {initialsFor(name)}
        </Text>
      )}
    </View>
  )
}

/** Initials are bold on every avatar size, whatever the size of the type around it. */
const INITIALS_WEIGHT = TYPE.headline.fontWeight

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  initials: {
    fontWeight: INITIALS_WEIGHT
  }
})
