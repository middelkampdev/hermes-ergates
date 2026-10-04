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
import { LEADING, RADIUS, RULE, SPACE, TYPE, type MobileTheme } from '@/theme/tokens'

import { astTableToRows, tableToStacked } from './markdown-table'

export interface MarkdownTextProps {
  children: string
}

function buildStyle(theme: MobileTheme): Record<string, TextStyle> {
  const fontFamily = Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' })
  const code: TextStyle = {
    backgroundColor: theme.colors.muted,
    color: theme.colors.foreground,
    borderWidth: 0,
    borderRadius: RADIUS.small,
    paddingHorizontal: SPACE.extraSmall,
    paddingVertical: SPACE.hairline,
    fontFamily
  }

  return {
    body: { color: theme.colors.foreground, ...TYPE.body, lineHeight: LEADING.body },
    // Space between paragraphs only; the first paragraph starts flush with the container.
    paragraph: { marginTop: 0, marginBottom: SPACE.small },
    heading1: { color: theme.colors.foreground, ...TYPE.largeTitle },
    heading2: { color: theme.colors.foreground, ...TYPE.title },
    heading3: { color: theme.colors.foreground, ...TYPE.title3 },
    heading4: { color: theme.colors.foreground, ...TYPE.headline },
    heading5: { color: theme.colors.foreground, ...TYPE.headline },
    heading6: { color: theme.colors.foreground, ...TYPE.headline },
    strong: { fontWeight: TYPE.headline.fontWeight },
    em: { fontStyle: 'italic' },
    s: { textDecorationLine: 'line-through' },
    link: { color: theme.colors.primary, textDecorationLine: 'underline' },
    blockquote: {
      backgroundColor: 'transparent',
      borderLeftWidth: 3,
      borderLeftColor: theme.colors.border,
      paddingLeft: SPACE.medium,
      marginLeft: 0
    },
    code_inline: code,
    code_block: { ...code, borderRadius: RADIUS.medium, padding: SPACE.medium },
    fence: { ...code, borderRadius: RADIUS.medium, padding: SPACE.medium },
    // The library defaults both list-content boxes to `{ flex: 1 }`, i.e. flexBasis 0. Yoga ignores an
    // explicit `flexBasis: 'auto'` while `flex` is positive, so the shorthand itself must be reset. Inside a
    // shrink-to-fit bubble that measures as zero width, so the text wraps one glyph per line and
    // spills out of the bubble. Grow and shrink as before, but start from the content's own width.
    bullet_list_content: { flex: 0, flexGrow: 1, flexShrink: 1 },
    ordered_list_content: { flex: 0, flexGrow: 1, flexShrink: 1 },
    table: { borderColor: theme.colors.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: RADIUS.medium },
    th: { padding: SPACE.small },
    tr: { borderColor: theme.colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
    td: { padding: SPACE.small },
    hr: { backgroundColor: theme.colors.border, height: StyleSheet.hairlineWidth }
  }
}

export function MarkdownText({ children }: MarkdownTextProps) {
  const theme = useTheme()
  const { width } = useWindowDimensions()
  const narrow = width < RULE.stackedTableWidth

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
    gap: SPACE.medium
  },
  row: {
    gap: SPACE.hairline
  },
  line: {
    ...TYPE.callout,
    lineHeight: LEADING.footnote
  }
})
