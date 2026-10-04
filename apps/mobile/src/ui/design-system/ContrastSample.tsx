/**
 * One foreground/background pair on the Design system page: "Aa" drawn in
 * the foreground on a chip of the background, the pair's token names, the
 * ratio to one decimal and the WCAG rating. A pair with a color that is not
 * hex has no ratio: it shows "—", no rating, and the raw values.
 */

import { StyleSheet, Text, View } from 'react-native'

import { isRenderableHex } from '@/theme/color'
import type { ContrastRating } from '@/theme/contrast'
import { useTheme } from '@/theme/provider'
import { RADIUS, SIZE, SPACE, TYPE } from '@/theme/tokens'

export interface ContrastSampleProps {
  fg: string
  bg: string
  fgValue: string
  bgValue: string
  ratio: number | null
  rating: ContrastRating | null
}

export function ContrastSample({ fg, bg, fgValue, bgValue, ratio, rating }: ContrastSampleProps) {
  const theme = useTheme()
  const chipColor = isRenderableHex(bgValue) ? bgValue : 'transparent'
  const textColor = isRenderableHex(fgValue) ? fgValue : theme.colors.foreground
  const ratioText = ratio === null ? '—' : ratio.toFixed(1)
  const summary = rating ? `${ratioText} · ${rating}` : ratioText

  return (
    <View style={styles.row} accessible accessibilityLabel={`${fg} on ${bg}, ratio ${ratioText}${rating ? `, ${rating}` : ''}`}>
      <View style={[styles.chip, { backgroundColor: chipColor, borderColor: theme.colors.border }]}>
        <Text style={[styles.sample, { color: textColor }]}>Aa</Text>
      </View>
      <View style={styles.text}>
        <Text style={[styles.pair, { color: theme.colors.foreground }]}>
          {fg} on {bg}
        </Text>
        {ratio === null ? (
          <Text style={[styles.detail, { color: theme.colors.mutedForeground }]}>
            {fgValue} on {bgValue}
          </Text>
        ) : null}
      </View>
      <Text style={[styles.summary, { color: theme.colors.mutedForeground }]}>{summary}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    minHeight: SIZE.extraLarge,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE.medium,
    paddingHorizontal: SPACE.large,
    paddingVertical: SPACE.small
  },
  chip: {
    width: SIZE.medium,
    height: SIZE.medium,
    borderRadius: RADIUS.medium,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center'
  },
  sample: {
    ...TYPE.headline
  },
  text: {
    flex: 1,
    gap: SPACE.hairline
  },
  pair: {
    ...TYPE.callout
  },
  detail: {
    ...TYPE.footnote
  },
  summary: {
    ...TYPE.footnoteStrong
  }
})
