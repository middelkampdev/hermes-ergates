/**
 * Themed markdown rendering (docs/10 section 4: body 17/24, code in `muted`,
 * links in `primary`, block quotes with a `border` bar). Below 400pt wide,
 * tables render as stacked "label: value" lines (docs 8 brief); at or above
 * that width they use the library's own table rendering.
 */

import { useMemo } from 'react'
import { Platform, StyleSheet, Text, View, useWindowDimensions, type TextStyle } from 'react-native'
import Markdown, { renderRules as defaultRenderRules, type RenderRules } from 'react-native-markdown-display'

import { useTheme } from '@/theme/provider'
import { LEADING, LEGACY_RADIUS, TYPE, type MobileTheme } from '@/theme/tokens'

import { astTableToRows, tableToStacked } from './markdown-table'

const NARROW_TABLE_WIDTH = 400
/** Large headings and bold text are heavier than the type scale's 600. */
const HEADING_WEIGHT = '700'
const HEADING2_SIZE = 24
const HEADING4_SIZE = 18
const STRONG_WEIGHT = '700'
/** Inline code is a tighter chip than the shared radii. */
const CODE_INLINE_RADIUS = 8
/** The stacked table lines sit a little tighter than the wrapping callout leading. */
const STACKED_LINE_HEIGHT = 20

export interface MarkdownTextProps {
  children: string
}

function buildStyle(theme: MobileTheme): Record<string, TextStyle> {
  const fontFamily = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
  const code: TextStyle = {
    backgroundColor: theme.colors.muted,
    color: theme.colors.foreground,
    borderWidth: 0,
    borderRadius: CODE_INLINE_RADIUS,
    paddingHorizontal: 6,
    paddingVertical: 2,
    fontFamily
  }

  return {
    body: { color: theme.colors.foreground, ...TYPE.body, lineHeight: LEADING.body },
    // Space between paragraphs only; the first paragraph starts flush with the container.
    paragraph: { marginTop: 0, marginBottom: 10 },
    heading1: { color: theme.colors.foreground, ...TYPE.largeTitle, fontWeight: HEADING_WEIGHT },
    heading2: { color: theme.colors.foreground, fontSize: HEADING2_SIZE, fontWeight: HEADING_WEIGHT },
    heading3: { color: theme.colors.foreground, ...TYPE.title3 },
    heading4: { color: theme.colors.foreground, fontSize: HEADING4_SIZE, fontWeight: TYPE.headline.fontWeight },
    heading5: { color: theme.colors.foreground, ...TYPE.headline },
    heading6: { color: theme.colors.foreground, ...TYPE.headline },
    strong: { fontWeight: STRONG_WEIGHT },
    em: { fontStyle: 'italic' },
    s: { textDecorationLine: 'line-through' },
    link: { color: theme.colors.primary, textDecorationLine: 'underline' },
    blockquote: {
      backgroundColor: 'transparent',
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.border,
      paddingLeft: 12,
      marginLeft: 0
    },
    code_inline: code,
    code_block: { ...code, borderRadius: LEGACY_RADIUS.small, padding: 12 },
    fence: { ...code, borderRadius: LEGACY_RADIUS.small, padding: 12 },
    // The library defaults both list-content boxes to `{ flex: 1 }`, i.e. flexBasis 0. Yoga ignores an
    // explicit `flexBasis: 'auto'` while `flex` is positive, so the shorthand itself must be reset. Inside a
    // shrink-to-fit bubble that measures as zero width, so the text wraps one glyph per line and
    // spills out of the bubble. Grow and shrink as before, but start from the content's own width.
    bullet_list_content: { flex: 0, flexGrow: 1, flexShrink: 1 },
    ordered_list_content: { flex: 0, flexGrow: 1, flexShrink: 1 },
    table: { borderColor: theme.colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: LEGACY_RADIUS.small },
    th: { padding: 8 },
    tr: { borderColor: theme.colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
    td: { padding: 8 },
    hr: { backgroundColor: theme.colors.border, height: StyleSheet.hairlineWidth }
  }
}

export function MarkdownText({ children }: MarkdownTextProps) {
  const theme = useTheme()
  const { width } = useWindowDimensions()
  const narrow = width < NARROW_TABLE_WIDTH

  const style = useMemo(() => buildStyle(theme), [theme])

  const rules = useMemo<RenderRules>(
    () => ({
      table: (node, renderedChildren, parentNodes, styles) => {
        if (!narrow) {
          return defaultRenderRules.table!(node, renderedChildren, parentNodes, styles)
        }
        const groups = tableToStacked(astTableToRows(node))
        return (
          <View key={node.key} style={stackedStyles.table}>
            {groups.map((group, i) => (
              <View key={i} style={stackedStyles.row}>
                {group.map((cell, j) => (
                  <Text key={j} style={[stackedStyles.line, { color: theme.colors.foreground }]}>
                    {cell.label ? (
                      <Text style={{ color: theme.colors.mutedForeground }}>{cell.label}: </Text>
                    ) : null}
                    {cell.value}
                  </Text>
                ))}
              </View>
            ))}
          </View>
        )
      }
    }),
    [narrow, theme]
  )

  return (
    <Markdown style={style} rules={rules}>
      {children}
    </Markdown>
  )
}

const stackedStyles = StyleSheet.create({
  table: {
    gap: 12
  },
  row: {
    gap: 2
  },
  line: {
    ...TYPE.callout,
    lineHeight: STACKED_LINE_HEIGHT
  }
})
